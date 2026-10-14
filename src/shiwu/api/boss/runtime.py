"""进程内运行时：识别管道、采集会话、事件缓冲、WebSocket 广播。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

import cv2
import numpy as np

from ...enroll import LocalGallery
from ...paths import ROOT, data_dir, videos_dir
from ...stream import (CallbackSink, EventBus, PipelineConfig, StreamPipeline, create_source,
                      available_sources)
from ...stream.annotate import draw_faces
from ...rules import DEFAULT_RULES, SERVER_ACTIONS, EventLog, RuleEngine, normalize_rules
from ...notify import Mailer, RateLimiter, SmtpConfig, SnapshotStore, build_alert_email
from ...stream.shared import SharedEngineView
from .capture import CaptureConfig, CaptureSession
from .mobile_preview import MobilePreview
from . import bridge

logger = logging.getLogger(__name__)
ROLES = {"boss": "老板", "leader": "领导", "staff": "同事", "whitelist": "白名单", "ignore": "忽略"}


class SourceRunner:
    """一路视频源：管道 + 最新画面 + 启动参数。"""

    def __init__(self, name: str):
        self.name = name
        self.pipeline: Optional[StreamPipeline] = None
        self.source: Dict[str, Any] = {}
        self.start_args: Dict[str, Any] = {}
        self.started_at: Optional[float] = None
        self.latest_jpeg: Optional[bytes] = None
        self.last_annot = None
        self.latest_faces: List[dict] = []
        self.last_push = 0.0


class BossRuntime:
    def __init__(self):
        self.port = int(os.getenv("SERVER_PORT", "7400"))
        self.token = os.getenv("SHIWU_API_TOKEN", "")
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.gallery = LocalGallery()
        self._engine = None          # 识别管道专用
        self._capture_engine = None  # 采集专用（引擎内部有 event loop，不能跨线程共用）
        self._engine_lock = threading.Lock()
        self.runners: Dict[str, SourceRunner] = {}
        self.mobile_preview = MobilePreview(self)
        self._infer_lock = threading.Lock()
        self.events: Deque[dict] = deque(maxlen=300)
        self.ws_clients: set = set()
        self.captures: Dict[str, CaptureSession] = {}
        self._names: Dict[str, dict] = {}
        self._names_at = 0.0
        self.rules_path = data_dir() / "rules.json"
        self.eventlog = EventLog()
        self.snapshots = SnapshotStore()
        self.mailer = Mailer()
        st = self.settings()
        self.email_limiter = RateLimiter(int(st.get("email_per_hour") or 0), float(st.get("email_min_interval_s") or 0))
        self.rule_engine = RuleEngine(self.rules(), on_action=self._on_action, eventlog=self.eventlog,
                                      on_prepare=self._on_prepare, on_leave=self._on_leave)
        self._ticker = threading.Thread(target=self._tick_loop, daemon=True, name="rule-tick")
        self._ticker.start()

    def members(self, force: bool = False) -> Dict[str, dict]:
        if force or time.time() - self._names_at > 5:
            self._names = bridge.members_snapshot()
            self._names_at = time.time()
        return self._names

    def name_of(self, pid: Optional[str]) -> Optional[str]:
        m = self.members().get(pid) if pid else None
        return m["name"] if m else None

    def role_of(self, pid: Optional[str]) -> Optional[str]:
        m = self.members().get(pid) if pid else None
        return m.get("role") if m else None

    # ---------- 引擎 ----------
    def engine(self, capture: bool = False):
        from ...stream.engine import LocalEngine
        with self._engine_lock:
            if capture:
                if self._capture_engine is None:
                    self._capture_engine = LocalEngine(min_face_size=40, gallery=self.gallery)
                return self._capture_engine
            if self._engine is None:
                self._engine = LocalEngine(min_face_size=40, gallery=self.gallery)
            return self._engine

    def known_match(self, emb: np.ndarray):
        with self._engine_lock:
            return self._known_match(emb)

    def _known_match(self, emb: np.ndarray):
        eng = self._capture_engine
        if eng._refresh_pending:
            eng._refresh_pending = False
            eng.refresh_gallery()
        M, ids = self.gallery.matrix()
        fx = eng._loop.run_until_complete(eng.recognizer.export_embeddings(None))
        if fx:
            M = np.vstack([M, np.stack(list(fx.values()))]) if len(M) else np.stack(list(fx.values()))
            ids = list(ids) + list(fx.keys())
        if len(ids) == 0:
            return None, 0.0
        sims = M @ emb
        j = int(np.argmax(sims))
        return (ids[j] if sims[j] >= 0.5 else None), float(sims[j])

    # ---------- 广播 ----------
    def _broadcast(self, payload: dict):
        if not self.ws_clients or self.loop is None:
            return
        for ws in list(self.ws_clients):
            fut = asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(payload, ensure_ascii=False)),
                                                   self.loop)
            fut.add_done_callback(lambda f, w=ws: f.exception() and self.ws_clients.discard(w))

    def _on_event(self, ev, source_name: Optional[str] = None):
        d = ev.to_dict()
        if source_name:
            d["source_id"] = source_name
        if ev.type == "frame_result":
            return  # 帧结果走 preview 通道，不进事件列表
        pid = d["data"].get("person_id")
        if pid:
            d["data"]["role"] = self.role_of(pid)
            d["data"]["role_label"] = ROLES.get(d["data"]["role"] or "", None)
        self.events.appendleft(d)
        self._broadcast({"type": "event", "event": d})
        if ev.type in ("person_recognized", "track_identity") and pid:
            self.eventlog.add("recognized", ts=d.get("wall_time"), person_id=pid, name=d["data"].get("name"),
                              role=d["data"]["role"], track_id=d["data"].get("track_id"),
                              similarity=d["data"].get("similarity"), source=d.get("source_id"),
                              detail=ev.type)

    def _tick_loop(self):
        while True:
            time.sleep(1.0)
            try:
                self.rule_engine.tick()
            except Exception:  # noqa: BLE001
                logger.exception("rule tick")

    def _on_prepare(self, ev: dict):
        """触发瞬间：保存带框快照（加密），把快照 id 写进事件。"""
        st = self.settings()
        if not st.get("snapshot_enabled", True):
            return
        r = self.runners.get(ev.get("source") or "")
        img = r.last_annot if r is not None else None
        if img is None:
            return
        try:
            img = img.copy()
            b = ev.get("bbox")
            if b and r.pipeline is not None:
                sc = img.shape[1] / max(1, (r.latest_faces[0]["frame_w"] if r.latest_faces else img.shape[1]))
                x, y, w, h = [int(v * sc) for v in b]
                cv2.rectangle(img, (x - 4, y - 4), (x + w + 4, y + h + 4), (0, 0, 255), 4)
            jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
            ev["snapshot"] = self.snapshots.save(jpeg, ev["ts"])
            self.snapshots.maybe_purge(float(st.get("snapshot_retention_days") or 0))
        except Exception:  # noqa: BLE001
            logger.exception("snapshot failed")

    def _on_leave(self, lv: dict):
        d = {"type": "left", "source_id": lv.get("source"), "frame_index": -1, "pts": 0.0,
             "wall_time": lv["ts"], "data": dict(lv, role_label=ROLES.get(lv.get("role") or ""))}
        self.events.appendleft(d)
        self._broadcast({"type": "leave", "leave": lv})
        logger.info("person left: %s after %.1fs", lv.get("name"), lv.get("away_s", 0))

    def run_server_actions(self, ev: dict) -> List[dict]:
        out = []
        for a in ev.get("actions") or []:
            if a["type"] == "email":
                out.append(self.action_email(ev, a.get("params") or {}))
        if out:
            self.eventlog.add("action_result", detail={"action_id": ev["id"], "results": out}, source="server")
            self._broadcast({"type": "action_result", "action_id": ev["id"], "results": out})
        return out

    def smtp_config(self) -> SmtpConfig:
        return SmtpConfig.from_settings(self.settings(), self.smtp_password())

    def action_email(self, ev: dict, params: dict, limit: bool = True) -> dict:
        t0 = time.time()
        cfg = self.smtp_config()
        if params.get("to"):
            cfg.recipients = [x.strip() for x in str(params["to"]).replace(";", ",").split(",") if x.strip()]
        if cfg.problems():
            return {"type": "email", "ok": False, "message": "邮件未配置：" + "；".join(cfg.problems())}
        if limit:
            ok, why = self.email_limiter.allow()
            if not ok:
                return {"type": "email", "ok": False, "skipped": True, "message": why}
        snap = None
        if ev.get("snapshot") and params.get("attach_snapshot", True):
            try:
                snap = self.snapshots.load(ev["snapshot"])
            except Exception:  # noqa: BLE001
                snap = None
        try:
            msg = build_alert_email(cfg, ev, snap, ROLES.get(ev.get("role") or ""))
            m = self.mailer.send(cfg, msg)
            return {"type": "email", "ok": True, "message": m + ("（含快照）" if snap else ""),
                    "ms": int((time.time() - t0) * 1000)}
        except Exception as e:  # noqa: BLE001
            return {"type": "email", "ok": False, "message": f"发送失败：{e}", "ms": int((time.time() - t0) * 1000)}

    def _on_action(self, ev: dict):
        if any(a["type"] in SERVER_ACTIONS for a in ev.get("actions") or []):
            threading.Thread(target=self.run_server_actions, args=(ev,), daemon=True).start()
        d = {"type": "action", "source_id": ev.get("source"), "frame_index": -1, "pts": 0.0,
             "wall_time": ev["ts"], "data": dict(ev, role_label=ROLES.get(ev["role"]))}
        self.events.appendleft(d)
        self._broadcast({"type": "action", "action": ev})
        logger.info("rule fired: %s %s -> %s", ev["name"], ev["role"], [a["type"] for a in ev["actions"]])

    # ---------- 监控开关 ----------
    def monitor_status(self) -> dict:
        return {"paused": self.rule_engine.paused, "fired": self.rule_engine.fired,
                "suppressed": self.rule_engine.suppressed,
                "pipeline_running": any(r.pipeline and r.pipeline._thread and r.pipeline._thread.is_alive()
                                        for r in self.runners.values())}

    def set_paused(self, paused: bool, source: str = "api") -> dict:
        if paused != self.rule_engine.paused:
            (self.rule_engine.pause if paused else self.rule_engine.resume)(source)
        st = self.monitor_status()
        self._broadcast({"type": "monitor", **st})
        return st

    def forget_person(self, pid: str):
        """删除人员时清理内存：事件缓冲、含该人的采集会话（其中有人脸裁图）。"""
        kept = [e for e in self.events if (e.get("data") or {}).get("person_id") != pid]
        self.events.clear()
        self.events.extend(kept)
        for sid, s in list(self.captures.items()):
            if any(c.person_id == pid or c.known_person_id == pid for c in s.clusters.values()):
                del self.captures[sid]
        for r in self.runners.values():
            r.latest_faces = [f for f in r.latest_faces if f.get("person_id") != pid]

    # ---------- 人员变更后主动刷新 ----------
    def invalidate_people(self):
        self.members(force=True)
        self.gallery.invalidate()
        for eng in (self._engine, self._capture_engine):
            if eng is not None:
                eng.request_refresh()

    # ---------- 多路管道 ----------
    @property
    def pipeline(self) -> Optional[StreamPipeline]:
        """兼容：第一条管道。"""
        r = next(iter(self.runners.values()), None)
        return r.pipeline if r else None

    @property
    def pipeline_source(self) -> Dict[str, Any]:
        r = next(iter(self.runners.values()), None)
        return r.source if r else {}

    @property
    def latest_jpeg(self) -> Optional[bytes]:
        r = next(iter(self.runners.values()), None)
        return r.latest_jpeg if r else None

    @property
    def latest_faces(self) -> List[dict]:
        return [f for r in self.runners.values() for f in r.latest_faces]

    def _on_frame(self, runner: "SourceRunner", frame, faces):
        annot = draw_faces(frame.image, faces, title=runner.name)
        h, w = annot.shape[:2]
        if w > 1280:
            annot = cv2.resize(annot, (1280, int(h * 1280 / w)))
        runner.last_annot = annot
        prev = annot if annot.shape[1] <= 960 else cv2.resize(annot, (960, int(annot.shape[0] * 960 / annot.shape[1])))
        runner.latest_jpeg = cv2.imencode(".jpg", prev, [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()
        fw = frame.image.shape[1]
        runner.latest_faces = [{"track_id": f.get("track_id"), "person_id": f.get("person_id"),
                                "name": f.get("name"), "role": self.role_of(f.get("person_id")),
                                "similarity": round(float(f.get("similarity", 0)), 3),
                                "identity_source": f.get("identity_source"), "source": runner.name,
                                "face_w": round(float((f.get("bbox") or {}).get("width", 0))), "frame_w": fw,
                                "bbox": [round(float((f.get("bbox") or {}).get(k, 0))) for k in ("x", "y", "width", "height")]}
                               for f in faces]
        self.rule_engine.observe(runner.latest_faces, source=runner.name)
        now = time.time()
        if now - runner.last_push >= 0.15 and self.ws_clients:
            runner.last_push = now
            import base64
            self._broadcast({"type": "frame", "source": runner.name, "pts": round(frame.pts, 2),
                             "jpeg": base64.b64encode(runner.latest_jpeg).decode(),
                             "faces": runner.latest_faces})

    def start_pipeline(self, kind: str, uri: str, loop: bool = True, fps: float = 25,
                       process_fps: float = 5, width: int = 0, height: int = 0,
                       adaptive: Optional[bool] = None, name: Optional[str] = None) -> dict:
        """name 为空：单路模式（停掉所有管道，启动“主画面”）；给定 name：新增/替换该路，其它路保持。"""
        if name is None:
            self.stop_pipeline()
            name = "主画面"
        name = name.strip()[:32] or "主画面"
        st = self.settings()
        if name not in self.runners and len(self.runners) >= int(st.get("max_sources", 4)):
            raise ValueError(f"最多同时运行 {st.get('max_sources', 4)} 路视频源（可在设置中调整）")
        self.stop_pipeline(name)
        opts: Dict[str, Any] = {}
        if kind == "file":
            uri = self.resolve_video(uri)
            opts = {"loop": loop, "fps": fps, "realtime": True}
        elif kind == "camera":
            opts = {"width": width, "height": height, "owner": f"识别管道「{name}」"}
        src = create_source(kind, uri, **opts)
        if kind == "camera":
            src.start()  # 同步打开：设备不存在/被占用直接返回给前端
        if adaptive is None:
            adaptive = bool(st.get("adaptive", True)) and kind in ("camera", "url")
        base = self.engine()
        base.refresh_gallery()
        self.members(force=True)
        runner = SourceRunner(name)
        bus = EventBus()
        bus.subscribe(CallbackSink(lambda ev, n=name: self._on_event(ev, n)))
        cfg = PipelineConfig(max_process_fps=process_fps, recognize_cooldown_s=5, adaptive=adaptive,
                             active_fps=float(st.get("active_fps", 8)), idle_fps=float(st.get("idle_fps", 2)))
        runner.pipeline = StreamPipeline(src, SharedEngineView(base, self._infer_lock), cfg, bus=bus,
                                         name_resolver=self.name_of,
                                         on_processed=lambda fr, fs, r=runner: self._on_frame(r, fr, fs))
        runner.source = {"name": name, "kind": kind, "uri": uri, "loop": loop, "width": width, "height": height,
                         "adaptive": adaptive}
        runner.start_args = dict(kind=kind, uri=uri, loop=loop, fps=fps, process_fps=process_fps,
                                 width=width, height=height, adaptive=adaptive, name=name)
        runner.started_at = time.time()
        self.runners[name] = runner
        self.rule_engine.reset(name)
        runner.pipeline.start(background=True)
        self._broadcast({"type": "pipeline", "source": runner.source, "sources": self._sources_brief()})
        return self.pipeline_status()

    def _sources_brief(self) -> List[dict]:
        return [r.source for r in self.runners.values()]

    def restart_pipeline(self, name: Optional[str] = None) -> dict:
        """休眠唤醒后重开（设备句柄通常已失效）。"""
        for r in [r for r in list(self.runners.values()) if name is None or r.name == name]:
            try:
                self.start_pipeline(**r.start_args)
            except Exception as e:  # noqa: BLE001
                logger.warning("restart %s failed: %s", r.name, e)
        return self.pipeline_status()

    def start_defaults(self) -> dict:
        st = self.settings()
        srcs = st.get("default_sources") or []
        if not srcs and st.get("default_source"):
            srcs = [dict(st["default_source"], name=st["default_source"].get("name") or "主画面")]
        self.stop_pipeline()
        errors = []
        for s in srcs:
            try:
                self.start_pipeline(s.get("kind", "file"), s["uri"], s.get("loop", True),
                                    width=int(s.get("width") or st.get("camera_width") or 0),
                                    height=int(s.get("height") or st.get("camera_height") or 0),
                                    name=s.get("name") or "主画面")
            except Exception as e:  # noqa: BLE001
                errors.append({"name": s.get("name"), "error": str(e)})
        return dict(self.pipeline_status(), start_errors=errors)

    def push_source(self, name: str):
        for r in self.runners.values():
            src = r.pipeline.source if r.pipeline else None
            if src is not None and getattr(src, "push_mode", False) and src.uri == f"push://{name}":
                return src
        return None

    def runner_for_push(self, name: str) -> Optional["SourceRunner"]:
        for r in self.runners.values():
            src = r.pipeline.source if r.pipeline else None
            if src is not None and getattr(src, "push_mode", False) and src.uri == f"push://{name}":
                return r
        return None

    # ---------- 设置 ----------
    DEFAULT_SETTINGS = {"default_source": None, "default_sources": [], "autostart": False, "auto_monitor": True,
                        "adaptive": True, "active_fps": 8, "idle_fps": 2, "camera_width": 1280,
                        "camera_height": 720, "max_sources": 4,
                        "snapshot_enabled": True, "snapshot_retention_days": 30,
                        "smtp_host": "", "smtp_port": 465, "smtp_security": "ssl", "smtp_user": "",
                        "smtp_from": "", "smtp_to": [], "smtp_verify_tls": True,
                        "email_per_hour": 6, "email_min_interval_s": 60}
    SECRET_KEYS = {"smtp_password"}

    def settings(self) -> dict:
        p = data_dir() / "settings.json"
        d = dict(self.DEFAULT_SETTINGS)
        if p.exists():
            try:
                d.update(json.loads(p.read_text("utf-8")))
            except Exception:  # noqa: BLE001
                pass
        return d

    def public_settings(self) -> dict:
        d = self.settings()
        d["smtp_password_set"] = bool(d.pop("smtp_password_enc", None))
        d["snapshots"] = self.snapshots.stats()
        return d

    def smtp_password(self) -> str:
        enc = self.settings().get("smtp_password_enc")
        if not enc:
            return ""
        import base64
        raw = base64.b64decode(enc)
        if raw.startswith(b"PLAIN:"):
            return raw[6:].decode()
        c = self.snapshots.cipher
        return c[1](raw).decode() if c else ""

    def save_settings(self, patch: dict) -> dict:
        d = self.settings()
        d.update({k: v for k, v in patch.items() if k in self.DEFAULT_SETTINGS})
        if patch.get("smtp_password") is not None:   # 授权码：加密存储；空字符串 = 清除
            import base64
            pw = str(patch["smtp_password"])
            if not pw:
                d.pop("smtp_password_enc", None)
            else:
                c = self.snapshots.cipher
                raw = c[0](pw.encode()) if c else b"PLAIN:" + pw.encode()
                d["smtp_password_enc"] = base64.b64encode(raw).decode()
        (data_dir() / "settings.json").write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
        self.email_limiter.per_hour = int(d.get("email_per_hour") or 0)
        self.email_limiter.min_interval_s = float(d.get("email_min_interval_s") or 0)
        pub = self.public_settings()
        self._broadcast({"type": "settings", "settings": pub})
        return pub

    def stop_pipeline(self, name: Optional[str] = None) -> dict:
        names = [name] if name else list(self.runners)
        stopped = False
        for n in names:
            r = self.runners.pop(n, None)
            if r:
                self.mobile_preview.invalidate_runner(r)
            if r and r.pipeline:
                r.pipeline.stop(5)
                stopped = True
        if stopped:
            self._broadcast({"type": "pipeline", "source": self.pipeline_source or None,
                             "sources": self._sources_brief()})
        return self.pipeline_status()

    def _runner_status(self, r: "SourceRunner") -> dict:
        p = r.pipeline
        running = bool(p and p._thread and p._thread.is_alive())
        return {"name": r.name, "running": running, "error": p.source.last_error if p else None,
                "source": r.source, "started_at": r.started_at, "stats": p.summary() if p else None,
                "faces": r.latest_faces if running else []}

    def pipeline_status(self) -> dict:
        items = [self._runner_status(r) for r in self.runners.values()]
        first = items[0] if items else None
        return {"running": any(i["running"] for i in items), "error": first["error"] if first else None,
                "source": first["source"] if first else None,
                "started_at": first["started_at"] if first else None,
                "stats": first["stats"] if first else None,
                "faces": [f for i in items for f in i["faces"]],
                "pipelines": items, "max_sources": int(self.settings().get("max_sources", 4)),
                "available_sources": available_sources()}

    # ---------- 素材 ----------
    def videos(self) -> List[dict]:
        out = []
        for p in sorted(videos_dir().glob("*.mp4")):
            cap = cv2.VideoCapture(str(p))
            n, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS) or 25
            out.append({"name": p.name, "path": str(p.relative_to(ROOT)),
                        "duration_s": round(n / fps, 1),
                        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))})
            cap.release()
        return out

    def resolve_video(self, uri: str) -> str:
        p = Path(uri)
        if not p.is_absolute():
            p = ROOT / uri
        p = p.resolve()
        if not p.is_file():
            raise FileNotFoundError(uri)
        return str(p)

    # ---------- 采集 ----------
    def start_capture(self, kind: str, uri: str, cfg: CaptureConfig) -> CaptureSession:
        if kind == "file":
            uri = self.resolve_video(uri)
        eng = self.engine(capture=True)
        eng.refresh_gallery()
        s = CaptureSession(eng, kind, uri, cfg, known_matcher=self.known_match)
        self.captures[s.id] = s
        # 只保留最近 5 个会话
        for sid in sorted(self.captures, key=lambda k: self.captures[k].created_at)[:-5]:
            del self.captures[sid]
        return s.start()

    # ---------- 规则 ----------
    def rules(self) -> List[dict]:
        if self.rules_path.exists():
            return normalize_rules(json.loads(self.rules_path.read_text("utf-8")))
        return normalize_rules(DEFAULT_RULES)

    def save_rules(self, rules: List[dict]) -> List[dict]:
        rules = normalize_rules(rules)
        self.rule_engine.set_rules(rules)
        self.rules_path.parent.mkdir(parents=True, exist_ok=True)
        self.rules_path.write_text(json.dumps(rules, ensure_ascii=False, indent=2), "utf-8")
        return rules


runtime = BossRuntime()
