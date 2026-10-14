"""/boss 路由：视频源控制、管道、采集会话、聚类编辑、确认入库、人员、规则、WebSocket。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Annotated, Any, Dict, List, Literal, Optional

import cv2
import numpy as np
from fastapi import APIRouter, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field, StringConstraints

from ...enroll import Candidate, EnrollmentService, QualityConfig, choose_templates
from ...rules import ACTION_TYPES
from . import bridge
from .capture import CaptureConfig
from .runtime import ROLES, runtime
from .mobile_preview import SECURITY_HEADERS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/boss", tags=["boss"])
GROUP_NAME = "默认组"
PersonName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


# ------------------------------------------------------------------ 状态
@router.get("/status")
def status():
    members = runtime.members(force=True)
    counts = runtime.gallery.count()
    return {
        "server": "ok", "time": time.time(),
        "pipeline": runtime.pipeline_status(),
        "people": {"total": len(members),
                   "with_face": sum(1 for m in members.values() if m.get("has_face_data")),
                   "by_role": {r: sum(1 for m in members.values() if m.get("role") == r) for r in ROLES}},
        "gallery": {"templates": sum(counts.values()), "persons": len(counts)},
        "recent_events": list(runtime.events)[:20],
        "captures": [s.to_dict(with_clusters=False) for s in runtime.captures.values()],
    }


@router.get("/roles")
def roles():
    return [{"value": k, "label": v} for k, v in ROLES.items()]


@router.get("/events")
def events(limit: int = 50, type: Optional[str] = None):
    ev = [e for e in runtime.events if not type or e["type"] == type]
    return ev[:limit]


# ------------------------------------------------------------------ 视频源 / 管道
@router.get("/sources/videos")
def videos():
    return runtime.videos()


class StartReq(BaseModel):
    kind: Literal["file", "url", "camera"] = "file"
    uri: str
    loop: bool = True
    fps: float = 25
    process_fps: float = 5
    width: int = 0
    height: int = 0
    adaptive: Optional[bool] = None
    name: Optional[str] = Field(None, max_length=32)


@router.post("/pipeline/start")
def pipeline_start(req: StartReq):
    from ...stream.sources.camera_source import CameraBusyError
    try:
        return runtime.start_pipeline(req.kind, req.uri, req.loop, req.fps, req.process_fps,
                                      req.width, req.height, req.adaptive, req.name)
    except FileNotFoundError as e:
        raise HTTPException(404, f"视频不存在: {e}")
    except CameraBusyError as e:
        raise HTTPException(409, str(e))
    except RuntimeError as e:
        raise HTTPException(404, str(e))
    except KeyError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(429, str(e))


@router.post("/pipeline/restart")
def pipeline_restart(name: Optional[str] = None):
    return runtime.restart_pipeline(name)


@router.post("/pipeline/start-defaults")
def pipeline_start_defaults():
    """按设置里的默认源（可多路）开始监控。"""
    return runtime.start_defaults()


@router.get("/sources/cameras")
def cameras():
    from ...stream.sources.camera_source import list_cameras
    return {"devices": list_cameras(),
            "push": [{"id": "push://electron", "name": "桌面端摄像头（getUserMedia）"}]}


@router.get("/settings")
def settings_get():
    return runtime.public_settings()


class TestEmail(BaseModel):
    to: Optional[str] = None


@router.post("/settings/test-email")
def settings_test_email(req: TestEmail = TestEmail()):
    """发送测试邮件（不受限流影响；附一张当前画面作为快照示例）。"""
    jpeg = None
    r = next(iter(runtime.runners.values()), None)
    if r is not None and r.latest_jpeg:
        jpeg = r.latest_jpeg
    ev = {"id": "test", "ts": time.time(), "name": "测试邮件", "role": None, "rule_id": "test",
          "source": r.name if r else "-", "actions": []}
    if jpeg:
        ev["snapshot"] = runtime.snapshots.save(jpeg)
    res = runtime.action_email(ev, {"to": req.to} if req.to else {}, limit=False)
    if ev.get("snapshot"):
        runtime.snapshots.delete(ev["snapshot"])
    if not res["ok"]:
        raise HTTPException(400, res["message"])
    return res


@router.put("/settings")
def settings_put(patch: Dict[str, Any]):
    return runtime.save_settings(patch)


@router.post("/pipeline/stop")
def pipeline_stop(name: Optional[str] = None):
    return runtime.stop_pipeline(name)


@router.get("/pipeline/status")
def pipeline_status():
    return runtime.pipeline_status()


@router.get("/preview.jpg")
def preview(source: Optional[str] = None):
    r = runtime.runners.get(source) if source else next(iter(runtime.runners.values()), None)
    if not r or not r.latest_jpeg:
        raise HTTPException(404, "暂无画面")
    return Response(r.latest_jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ 临时手机预览
class MobilePreviewReq(BaseModel):
    source: str = Field(..., min_length=1, max_length=32)
    address: Optional[str] = Field(None, min_length=1, max_length=15)


@router.get("/mobile-preview")
def mobile_preview_list(response: Response):
    response.headers.update(SECURITY_HEADERS)
    return runtime.mobile_preview.sessions()


@router.post("/mobile-preview")
def mobile_preview_create(req: MobilePreviewReq, response: Response):
    response.headers.update(SECURITY_HEADERS)
    return runtime.mobile_preview.create(req.source, req.address)


@router.delete("/mobile-preview")
def mobile_preview_disconnect(response: Response, source: str = Query(..., min_length=1, max_length=32)):
    response.headers.update(SECURITY_HEADERS)
    return runtime.mobile_preview.revoke_source(source)


@router.delete("/mobile-preview/{sid}")
def mobile_preview_revoke(sid: str, response: Response):
    response.headers.update(SECURITY_HEADERS)
    return runtime.mobile_preview.revoke(sid)


# ------------------------------------------------------------------ 一键采集
class CaptureReq(BaseModel):
    kind: Literal["file", "url", "camera"] = "file"
    uri: str
    duration_s: float = Field(15, gt=0, le=300)
    fps: float = Field(5, gt=0, le=15)
    eps: float = Field(0.42, gt=0, lt=1)
    min_samples: int = 3


def _session(sid: str):
    s = runtime.captures.get(sid)
    if not s:
        raise HTTPException(404, "采集会话不存在")
    return s


@router.post("/captures")
def capture_start(req: CaptureReq):
    try:
        s = runtime.start_capture(req.kind, req.uri, CaptureConfig(
            duration_s=req.duration_s, fps=req.fps, eps=req.eps, min_samples=req.min_samples))
    except FileNotFoundError as e:
        raise HTTPException(404, f"视频不存在: {e}")
    return s.to_dict()


@router.get("/captures")
def capture_list():
    return [s.to_dict(with_clusters=False) for s in
            sorted(runtime.captures.values(), key=lambda s: -s.created_at)]


@router.get("/captures/{sid}")
def capture_get(sid: str):
    d = _session(sid).to_dict()
    for c in d.get("clusters", []):
        if c["known_person_id"]:
            c["known_name"] = runtime.name_of(c["known_person_id"])
    return d


@router.delete("/captures/{sid}")
def capture_cancel(sid: str):
    s = _session(sid)
    s.cancel()
    runtime.captures.pop(sid, None)
    return {"success": True}


@router.get("/captures/{sid}/samples/{sample_id}.jpg")
def capture_sample(sid: str, sample_id: int, size: int = 160):
    s = _session(sid)
    if sample_id not in s.samples:
        raise HTTPException(404)
    return Response(s.crop_jpeg(sample_id, size), media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=3600"})


class MergeReq(BaseModel):
    cluster_ids: List[int] = Field(..., min_length=2)


@router.post("/captures/{sid}/merge")
def capture_merge(sid: str, req: MergeReq):
    s = _session(sid)
    try:
        c = s.merge(req.cluster_ids)
    except KeyError as e:
        raise HTTPException(404, f"簇不存在: {e}")
    return s.cluster_dict(c)


class SplitReq(BaseModel):
    sample_ids: Optional[List[int]] = None
    by_track: bool = False


@router.post("/captures/{sid}/clusters/{cid}/split")
def capture_split(sid: str, cid: int, req: SplitReq):
    s = _session(sid)
    if cid not in s.clusters:
        raise HTTPException(404, "簇不存在")
    return [s.cluster_dict(c) for c in s.split(cid, req.sample_ids, req.by_track)]


class ConfirmReq(BaseModel):
    action: Literal["enroll", "ignore"] = "enroll"
    name: Optional[PersonName] = None
    role: Optional[str] = "boss"
    person_id: Optional[str] = None   # 提供则补录到已有人员；省略姓名/分组时保持原值
    max_templates: int = Field(5, ge=1, le=10)


async def _group_id() -> str:
    """默认组的 id，不存在就建。"""
    return await bridge.ensure_group(GROUP_NAME)


async def _enroll_primary(gid: str, pid: str, img: np.ndarray, face: dict) -> bool:
    """把一张人脸写进识别库作为主模板。"""
    return await bridge.enroll_primary_face(gid, pid, img, face)


@router.post("/captures/{sid}/clusters/{cid}/confirm")
async def capture_confirm(sid: str, cid: int, req: ConfirmReq):
    s = _session(sid)
    cl = s.clusters.get(cid)
    if not cl:
        raise HTTPException(404, "簇不存在")
    if req.action == "ignore":
        cl.status, cl.role = "ignored", "ignore"
        return s.cluster_dict(cl)

    m = None
    if req.person_id:
        m = runtime.members(force=True).get(req.person_id)
        if not m:
            raise HTTPException(404, "人员不存在")
        if not (req.name or (m.get("name") or "").strip()):
            raise HTTPException(400, "请先在人员管理中填写姓名")
    elif not req.name:
        raise HTTPException(400, "请填写姓名，分组不能代替姓名")

    cands = []
    for i in cl.sample_ids:
        smp = s.samples[i]
        cd = Candidate(None, {"bbox": smp.bbox, "landmarks_5": smp.landmarks_5,
                              "confidence": smp.confidence}, None, pts=smp.pts,
                       embedding=smp.embedding, source=f"capture:{sid}#{i}")
        cd.image_shape = s.frame_shapes[smp.frame_id]
        cd.sample_id = i
        cands.append(cd)
    chosen = choose_templates(cands, QualityConfig(), req.max_templates)
    if not chosen:
        reasons = {}
        for cd in cands:
            for r in (cd.quality.reasons if cd.quality else []):
                k = r.split("(")[0]
                reasons[k] = reasons.get(k, 0) + 1
        raise HTTPException(400, {"message": "该人物没有符合注册质量门槛的照片", "reasons": reasons})

    if req.person_id:
        pid = req.person_id
        gid = m["group_id"]
        # 兼容显式改名/改分组；仅传 person_id 的补录不得改变身份信息。
        upd = {k: v for k, v in (("role", req.role), ("name", req.name))
               if k in req.model_fields_set and v}
        if upd:
            updated = await bridge.update_member(pid, upd)
            if updated is None:
                raise HTTPException(404, "人员不存在")
            m = updated
    else:
        gid = await _group_id()
        m = await bridge.create_member(req.name, gid, req.role)
        pid = m["person_id"]
    if not m.get("has_face_data"):
        best = chosen[0]
        await _enroll_primary(gid, pid, s.frame_image(s.samples[best.sample_id].frame_id), best.face)
    name = m["name"]
    for cd in chosen:
        runtime.gallery.add(pid, cd.embedding, name=name, quality=cd.quality.metrics, source=cd.source)
    cl.status, cl.person_id, cl.name, cl.role = "enrolled", pid, name, m.get("role")
    runtime.invalidate_people()
    d = s.cluster_dict(cl)
    d["enrolled_templates"] = [{"sample_id": cd.sample_id, "width": cd.quality.metrics.get("width"),
                                "yaw_ratio": cd.quality.metrics.get("yaw_ratio"),
                                "relaxed_pose": bool(cd.quality.metrics.get("relaxed_pose"))} for cd in chosen]
    return d


# ------------------------------------------------------------------ 人员
@router.get("/people")
def people():
    counts = runtime.gallery.count()
    out = []
    for pid, m in runtime.members(force=True).items():
        out.append({**m, "templates": counts.get(pid, 0) + (1 if m.get("has_face_data") else 0),
                    "role_label": ROLES.get(m.get("role") or "", "未设置")})
    return sorted(out, key=lambda m: m.get("joined_at") or "", reverse=True)


class PersonCreate(BaseModel):
    name: PersonName
    role: Optional[str] = None


@router.post("/people")
async def person_create(req: PersonCreate):
    m = await bridge.create_member(req.name, await _group_id(), req.role)
    runtime.invalidate_people()
    return m


class PersonUpdate(BaseModel):
    name: Optional[PersonName] = None
    role: Optional[str] = None


@router.put("/people/{pid}")
async def person_update(pid: str, req: PersonUpdate):
    body = {k: v for k, v in req.model_dump().items() if v is not None}
    try:
        m = await bridge.update_member(pid, body)
    except LookupError as e:
        raise HTTPException(404, str(e))
    if m is None:
        raise HTTPException(404, "人员不存在")
    runtime.invalidate_people()
    return m


@router.delete("/people/{pid}")
async def person_delete(pid: str):
    """彻底删除：人脸模板（硬删）+ 成员（先匿名化再软删）
    + 多模板库（删行并 VACUUM）+ 事件日志中该人记录 + 内存中的采集样本/事件。"""
    if pid not in runtime.members(force=True):
        raise HTTPException(404, "人员不存在")
    await bridge.update_member(pid, {"name": "已删除人员", "role": None, "email": None})
    await bridge.remove_person_faces(pid)
    ok = await bridge.delete_member(pid)
    face_left = await bridge.person_has_faces(pid)
    removed = runtime.gallery.remove_person(pid)
    log_removed = runtime.eventlog.purge_person(pid)
    runtime.forget_person(pid)
    runtime.invalidate_people()
    return {"success": ok, "templates_removed": removed, "eventlog_removed": log_removed,
            "verify": {"face_remaining": face_left,
                       "gallery_remaining": runtime.gallery.count().get(pid, 0)}}


@router.post("/people/{pid}/photos")
async def person_photos(pid: str, files: List[UploadFile] = File(...)):
    """补录：上传多张照片，经质量门槛后写入多模板库。"""
    if pid not in [m["person_id"] for m in await bridge.list_members()]:
        raise HTTPException(404, "人员不存在")
    loop = asyncio.get_running_loop()
    imgs, names = [], []
    for f in files:
        data = await f.read()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is not None:
            imgs.append(img)
            names.append(f.filename)

    def work():
        eng = runtime.engine(capture=True)
        with runtime._engine_lock:
            svc = EnrollmentService(eng, runtime.gallery)
            return svc.enroll_images(pid, imgs, runtime.name_of(pid) or "", sources=names)
    rep = await loop.run_in_executor(None, work)
    await loop.run_in_executor(None, runtime.invalidate_people)
    return {"accepted": len(rep.accepted), "rejected": rep.rejected,
            "templates": runtime.gallery.count().get(pid, 0)}


# ------------------------------------------------------------------ 规则 / 监控 / 事件日志
class RuleAction(BaseModel):
    type: str
    params: Dict[str, Any] = Field(default_factory=dict)


class TimeWindow(BaseModel):
    days: List[int] = Field(default_factory=list)
    start: str = Field("00:00", pattern=r"^\d{1,2}:\d{2}$")
    end: str = Field("24:00", pattern=r"^\d{1,2}:\d{2}$")


class Rule(BaseModel):
    id: Optional[str] = None
    role: Optional[str] = None
    person_ids: List[str] = Field(default_factory=list)
    stranger: bool = False
    stranger_after_s: float = Field(5, ge=0, le=3600)
    whitelist: bool = False
    suppress_others: bool = False
    priority: Optional[int] = Field(None, ge=-1000, le=1000)
    sources: List[str] = Field(default_factory=list)
    schedule: List[TimeWindow] = Field(default_factory=list)
    min_face_px: int = Field(0, ge=0, le=4000)
    min_face_ratio: float = Field(0, ge=0, le=1)
    restore_on_leave: bool = False
    leave_after_s: float = Field(15, ge=1, le=3600)
    enabled: bool = True
    min_frames: int = Field(3, ge=1, le=100)
    cooldown_s: float = Field(30, ge=0, le=86400)
    actions: List[RuleAction] = Field(default_factory=list)
    note: Optional[str] = None


@router.get("/rules")
def rules_get():
    return {"rules": runtime.rules(),
            "actions": [{"value": k, "label": v} for k, v in ACTION_TYPES.items()]}


@router.put("/rules")
def rules_put(rules: List[Rule]):
    bad = [a.type for r in rules for a in r.actions if a.type not in ACTION_TYPES]
    if bad:
        raise HTTPException(400, f"未知动作：{bad}")
    empty = [r.id or "?" for r in rules if not (r.role or r.person_ids or r.stranger)]
    if empty:
        raise HTTPException(400, f"规则没有指定对象（角色/人员/陌生人）：{empty}")
    return {"rules": runtime.save_rules([r.model_dump() for r in rules])}


@router.get("/monitor")
def monitor_get():
    return runtime.monitor_status()


@router.post("/monitor/pause")
def monitor_pause(source: str = "api"):
    return runtime.set_paused(True, source)


@router.post("/monitor/resume")
def monitor_resume(source: str = "api"):
    return runtime.set_paused(False, source)


class TestAction(BaseModel):
    role: str = "boss"
    name: str = "测试"
    rule_id: Optional[str] = None


@router.post("/monitor/test")
def monitor_test(req: TestAction):
    """按角色规则直接发出一次 action（不经识别），用于在桌面端验证动作。"""
    rule = runtime.rule_engine.rule_by_id(req.rule_id) if req.rule_id else runtime.rule_engine.rule_for(req.role)
    if not rule:
        raise HTTPException(404, "该角色没有启用的规则")
    import uuid as _u
    ev = {"id": _u.uuid4().hex[:12], "ts": time.time(), "rule_id": rule["id"], "role": rule["role"],
          "person_id": None, "name": req.name, "track_id": None, "similarity": 0, "frames": 0,
          "actions": rule["actions"], "source": "test"}
    runtime.eventlog.add("action", ts=ev["ts"], name=req.name, role=rule["role"], rule_id=rule["id"],
                         actions=rule["actions"], source="test", detail={"event_id": ev["id"]})
    runtime._on_action(ev)
    return ev


# ------------------------------------------------------------------ 快照 / 时间线 / 统计
@router.get("/snapshots/{day}/{sid}.jpg")
def snapshot_get(day: str, sid: str):
    try:
        data = runtime.snapshots.load(f"{day}/{sid}")
    except Exception:  # noqa: BLE001
        raise HTTPException(404, "快照不存在或已过期")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/timeline")
def timeline(start: Optional[float] = None, end: Optional[float] = None, person_id: Optional[str] = None,
             role: Optional[str] = None, source: Optional[str] = None, kinds: str = "action,left",
             limit: int = Query(200, ge=1, le=2000)):
    """按时间回看触发事件（含快照）；可按人员/角色/源筛选。"""
    q, a = "SELECT * FROM event_log WHERE kind IN (%s)" % ",".join("?" * len(kinds.split(","))), kinds.split(",")
    for col, v, op in (("ts", start, ">="), ("ts", end, "<"), ("person_id", person_id, "="), ("role", role, "="),
                       ("source", source, "=")):
        if v is not None and v != "":
            q += f" AND {col} {op} ?"
            a.append(v)
    q += " ORDER BY ts DESC LIMIT ?"
    a.append(limit)
    el = runtime.eventlog
    with el._lock:
        cur = el._db.execute(q, a)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    for r in rows:
        for k in ("actions", "detail"):
            if r[k] and r[k][:1] in "[{":
                r[k] = json.loads(r[k])
        r["role_label"] = ROLES.get(r.get("role") or "", None)
        r["snapshot_url"] = (f"/boss/snapshots/{r['snapshot']}.jpg"
                             if r.get("snapshot") and runtime.snapshots.exists(r["snapshot"]) else None)
    return rows


@router.get("/stats")
def stats(days: int = Query(7, ge=1, le=90), person_id: Optional[str] = None, role: Optional[str] = None,
          source: Optional[str] = None):
    from ...rules.stats import compute
    d = compute(runtime.eventlog, days, person_id, role, source)
    for p in d["people"]:
        p["role_label"] = ROLES.get(p.get("role") or "", p.get("role"))
    return d


@router.get("/stats/export.csv")
def stats_csv(days: int = Query(7, ge=1, le=90), person_id: Optional[str] = None, role: Optional[str] = None,
              source: Optional[str] = None):
    from ...rules.stats import compute, to_csv
    body = to_csv(compute(runtime.eventlog, days, person_id, role, source), ROLES)
    return Response(body.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="boss-stats-{days}d.csv"'})


@router.get("/sources/names")
def source_names():
    """规则可限定的视频源名称：运行中 + 默认源 + 历史事件里出现过的。"""
    names = list(runtime.runners)
    for s in runtime.settings().get("default_sources") or []:
        if s.get("name") and s["name"] not in names:
            names.append(s["name"])
    with runtime.eventlog._lock:
        for (n,) in runtime.eventlog._db.execute(
                "SELECT DISTINCT source FROM event_log WHERE source IS NOT NULL AND kind='recognized' LIMIT 50"):
            if n and n not in names and n not in ("test", "desktop", "server", "api"):
                names.append(n)
    return names


@router.get("/eventlog")
def eventlog(limit: int = Query(100, ge=1, le=1000), kind: Optional[str] = None,
             before_id: Optional[int] = None):
    return runtime.eventlog.list(limit, kind, before_id)


class ActionResult(BaseModel):
    action_id: str
    results: List[Dict[str, Any]]


@router.post("/actions/result")
def action_result(req: ActionResult):
    """桌面端 ActionExecutor 回报执行结果，写入事件日志。"""
    runtime.eventlog.add("action_result", detail={"action_id": req.action_id, "results": req.results},
                         source="desktop")
    return {"ok": True}


# ------------------------------------------------------------------ 摄像头推流
@router.websocket("/camera/push")
async def camera_push(websocket: WebSocket, token: str = Query(""), name: str = Query("electron")):
    """Electron/浏览器 getUserMedia → 每帧一条二进制 JPEG 消息 → CameraSource.push_frame。
    服务端每 25 帧回 {"type":"ack","accepted":n,"target_fps":x}；没有对应管道时回 {"type":"idle"}。"""
    from shiwu.app import is_valid_local_token
    if not is_valid_local_token(token):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    n = 0
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if not data:
                continue
            src = runtime.push_source(name)
            if src is None:
                if n % 25 == 0:
                    await websocket.send_text(json.dumps({"type": "idle"}))
                n += 1
                continue
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if img is not None and src.push_frame(img):
                n += 1
                if n % 25 == 0:
                    r = runtime.runner_for_push(name)
                    p = r.pipeline if r else None
                    await websocket.send_text(json.dumps({"type": "ack", "accepted": n,
                                                          "target_fps": p.stats.get("target_fps") if p else None}))
    except WebSocketDisconnect:
        pass


# ------------------------------------------------------------------ WebSocket
@router.websocket("/ws")
async def ws(websocket: WebSocket, token: str = Query("")):
    from shiwu.app import is_valid_local_token  # 本机 token 校验
    if not is_valid_local_token(token):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    runtime.loop = asyncio.get_running_loop()
    runtime.ws_clients.add(websocket)
    try:
        await websocket.send_text(json.dumps({"type": "hello", "pipeline": runtime.pipeline_status(),
                                              "monitor": runtime.monitor_status()},
                                             ensure_ascii=False))
        while True:
            await websocket.receive_text()   # 心跳 / 忽略
    except WebSocketDisconnect:
        pass
    finally:
        runtime.ws_clients.discard(websocket)
