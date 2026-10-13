"""/boss 接口集成测试：在临时数据目录里用随机端口起一个真实服务进程，
跑通 采集 → 确认入库（补录到已有人员改名改角色）→ 管道识别 → 规则触发 → 删除彻底清除。
需要 ONNX 模型与素材视频；缺失时跳过。约 40–60 秒。"""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import cv2
import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
PY = Path(sys.executable)
V1 = ROOT / "assets" / "videos" / "pexels_9652476.mp4"
V2 = ROOT / "assets" / "videos" / "pexels_9652478.mp4"
TOKEN = "pytest-token"

pytestmark = pytest.mark.skipif(
    not (V1.exists() and V2.exists() and PY.exists()), reason="缺少素材或解释器"
)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    d = tmp_path_factory.mktemp("boss")
    port = free_port()
    env = dict(os.environ, SHIWU_API_TOKEN=TOKEN, SHIWU_GALLERY_DIR=str(d / "facenox"),
               SHIWU_DATA_DIR=str(d / "boss"), SHIWU_MACHINE_KEY="11" * 32)
    env.pop("DBUS_SESSION_BUS_ADDRESS", None)
    log = open(d / "server.log", "w")
    p = subprocess.Popen([str(PY), "-m", "shiwu", "--port", str(port)],
                         env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=f"http://127.0.0.1:{port}/boss", headers={"X-Shiwu-Token": TOKEN}, timeout=60)
    for _ in range(120):
        try:
            if c.get("/monitor").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        if p.poll() is not None:
            raise RuntimeError((d / "server.log").read_text())
        time.sleep(0.5)
    yield {"c": c, "port": port, "dir": d}
    p.terminate()
    p.wait(10)


def wait_capture(c, sid, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = c.get(f"/captures/{sid}").json()
        if d["status"] in ("ready", "error"):
            return d
        time.sleep(1)
    raise TimeoutError


def test_requires_token(server):
    r = httpx.get(f"http://127.0.0.1:{server['port']}/boss/status")
    assert r.status_code == 401
    r = httpx.get(f"http://127.0.0.1:{server['port']}/boss/status?token={TOKEN}")
    assert r.status_code == 200


def test_status_roles_videos(server):
    c = server["c"]
    s = c.get("/status").json()
    assert s["server"] == "ok" and s["people"]["total"] == 0
    assert {r["value"] for r in c.get("/roles").json()} == {"boss", "leader", "staff", "whitelist", "ignore"}
    assert any(v["name"] == V1.name for v in c.get("/sources/videos").json())


def test_rules_crud_and_validation(server):
    c = server["c"]
    d = c.get("/rules").json()
    assert {a["value"] for a in d["actions"]} >= {"notify", "cover", "minimize_all", "lock_screen", "command"}
    assert any(r["role"] == "boss" for r in d["rules"])
    assert c.put("/rules", json=[{"role": "boss", "actions": [{"type": "rm"}]}]).status_code == 400
    rules = [{"role": "boss", "min_frames": 2, "cooldown_s": 60,
              "actions": [{"type": "notify", "params": {}}, {"type": "cover", "params": {}},
                          {"type": "minimize_all", "params": {}}]},
             {"role": "leader", "enabled": False, "actions": [{"type": "notify"}]}]
    out = c.put("/rules", json=rules).json()["rules"]
    assert out[0]["min_frames"] == 2 and out[0]["id"] == "boss"
    assert c.get("/rules").json()["rules"][0]["cooldown_s"] == 60


def test_monitor_pause_resume_and_test_action(server):
    c = server["c"]
    assert c.post("/monitor/pause").json()["paused"] is True
    assert c.get("/monitor").json()["paused"] is True
    assert c.post("/monitor/resume").json()["paused"] is False
    ev = c.post("/monitor/test", json={"role": "boss", "name": "演示"}).json()
    assert [a["type"] for a in ev["actions"]] == ["notify", "cover", "minimize_all"]
    kinds = [r["kind"] for r in c.get("/eventlog", params={"limit": 5}).json()]
    assert kinds[:3] == ["action", "monitor_resumed", "monitor_paused"]
    assert c.post("/monitor/test", json={"role": "leader"}).status_code == 404
    assert c.post("/actions/result", json={"action_id": ev["id"], "results": [{"type": "notify", "ok": True}]}).json()["ok"]


def test_websocket_auth_and_hello(server):
    import asyncio
    import websockets

    async def go():
        url = f"ws://127.0.0.1:{server['port']}/boss/ws?token="
        with pytest.raises(Exception):
            async with websockets.connect(url + "bad") as ws:
                await ws.recv()
        async with websockets.connect(url + TOKEN) as ws:
            m = json.loads(await ws.recv())
            assert m["type"] == "hello" and "monitor" in m
    asyncio.run(go())


def test_people_create_update_photos(server):
    c = server["c"]
    p = c.post("/people", json={"name": "临时", "role": "staff"}).json()
    pid = p["person_id"]
    assert c.put(f"/people/{pid}", json={"name": "张三", "role": "leader"}).json()["name"] == "张三"
    cap = cv2.VideoCapture(str(V1))
    cap.set(cv2.CAP_PROP_POS_MSEC, 2360)
    ok, frame = cap.read()
    assert ok
    jpg = cv2.imencode(".jpg", frame)[1].tobytes()
    r = c.post(f"/people/{pid}/photos", files=[("files", ("f.jpg", jpg, "image/jpeg")),
                                              ("files", ("bad.jpg", b"not an image", "image/jpeg"))]).json()
    assert r["accepted"] == 1 and r["templates"] == 1
    row = [x for x in c.get("/people").json() if x["person_id"] == pid][0]
    assert row["role"] == "leader" and row["role_label"] == "领导"
    d = c.delete(f"/people/{pid}").json()
    assert d["success"] and d["templates_removed"] == 1 and d["verify"]["gallery_remaining"] == 0
    assert pid not in [x["person_id"] for x in c.get("/people").json()]


def test_end_to_end_capture_enroll_recognize_fire_delete(server):
    c = server["c"]
    # 1) 先建一个已有人员，用于验证「补录到已有人员」会改名 + 改角色
    pid = c.post("/people", json={"name": "旧名字", "role": "staff"}).json()["person_id"]
    sid = c.post("/captures", json={"kind": "file", "uri": str(V1), "duration_s": 8, "fps": 5}).json()["id"]
    cap = wait_capture(c, sid)
    assert cap["status"] == "ready", cap.get("error")
    big = max(cap["clusters"], key=lambda x: x["quality_ok"])
    assert big["quality_ok"] >= 3
    # 拆分 / 合并
    if len(big["tracks"]) > 1:
        parts = c.post(f"/captures/{sid}/clusters/{big['id']}/split", json={"by_track": True}).json()
        merged = c.post(f"/captures/{sid}/merge", json={"cluster_ids": [x["id"] for x in parts]}).json()
        big = merged
    r = c.post(f"/captures/{sid}/clusters/{big['id']}/confirm",
               json={"action": "enroll", "name": "王总", "role": "boss", "person_id": pid})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "enrolled" and 1 <= len(r.json()["enrolled_templates"]) <= 5
    row = [x for x in c.get("/people").json() if x["person_id"] == pid][0]
    assert row["name"] == "王总" and row["role"] == "boss"          # 第 2 阶段遗留修复
    # 2) 播放另一段视频：识别出王总并触发规则（min_frames=2）
    c.post("/monitor/resume")
    c.post("/pipeline/start", json={"kind": "file", "uri": str(V2), "loop": False})
    t0, fired = time.time(), []
    while time.time() - t0 < 40 and not fired:
        time.sleep(1)
        fired = [e for e in c.get("/eventlog", params={"kind": "action"}).json()
                 if e["person_id"] == pid]
    c.post("/pipeline/stop")
    assert fired, "未触发老板规则"
    assert fired[0]["name"] == "王总" and fired[0]["role"] == "boss"
    rec = c.get("/eventlog", params={"kind": "recognized"}).json()
    assert any(e["person_id"] == pid for e in rec)
    assert len(fired) == 1                                         # 冷却去抖（60s）
    # 3) 删除：识别库模板 / 多模板库 / 事件日志 / 内存会话全部清掉
    d = c.delete(f"/people/{pid}").json()
    assert d["verify"] == {"face_remaining": False, "gallery_remaining": 0}
    assert d["eventlog_removed"] >= 2
    assert all(e["person_id"] != pid for e in c.get("/eventlog", params={"limit": 1000}).json())
    assert c.get(f"/captures/{sid}").status_code == 404
    import sqlite3
    g = sqlite3.connect(server["dir"] / "boss" / "templates.db")
    assert g.execute("SELECT COUNT(*) FROM templates WHERE person_id=?", (pid,)).fetchone()[0] == 0
    # 已入库模板都是加密的
    assert g.execute("SELECT COUNT(*) FROM templates WHERE enc=0").fetchone()[0] == 0


def test_cameras_settings_and_push(server):
    import asyncio
    import websockets
    c = server["c"]
    cams = c.get("/sources/cameras").json()
    assert cams["push"][0]["id"] == "push://electron"
    s = c.put("/settings", json={"autostart": True, "default_source": {"kind": "camera", "uri": "push://electron"},
                                 "bogus": 1}).json()
    assert s["autostart"] and "bogus" not in s and s["adaptive"] is True
    # 不存在的摄像头：Linux 能看 /dev/video* 节点，报 404；macOS/Windows 无法靠节点判断，报 409（被占用/of 无权限）。
    assert c.post("/pipeline/start", json={"kind": "camera", "uri": "/dev/video63"}).status_code in (404, 409)
    st = c.post("/pipeline/start", json={"kind": "camera", "uri": "push://electron"}).json()
    assert st["running"] and st["source"]["adaptive"] is True
    cap = cv2.VideoCapture(str(V2))
    cap.set(cv2.CAP_PROP_POS_MSEC, 9000)
    jpgs = []
    for _ in range(30):
        ok, f = cap.read()
        jpgs.append(cv2.imencode(".jpg", cv2.resize(f, (640, 338)))[1].tobytes())

    async def go():
        async with websockets.connect(f"ws://127.0.0.1:{server['port']}/boss/camera/push?token={TOKEN}") as ws:
            msgs = []
            for j in jpgs:
                await ws.send(j)
                await asyncio.sleep(0.05)
            msgs.append(json.loads(await asyncio.wait_for(ws.recv(), 5)))
            return msgs
    msgs = asyncio.run(go())
    assert msgs[0]["type"] == "ack" and msgs[0]["accepted"] == 25
    time.sleep(1)
    st = c.get("/pipeline/status").json()
    assert st["stats"]["frames_read"] >= 20 and st["stats"]["frames_processed"] >= 3
    c.post("/pipeline/stop")
