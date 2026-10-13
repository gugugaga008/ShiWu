"""v1.1 端到端（素材视频 + 真实服务进程 + 本地 aiosmtpd，不向任何真实邮箱发信）：
两路源并发（门口/桌面）、按源限定的老板规则 → 遮挡+邮件（带加密快照附件）、陌生人规则、
离开检测、时间线与快照、白名单不触发、统计与 CSV、授权码加密存储。约 2 分钟。"""
import email
import email.policy
import json
import time

import pytest

from test_api import PY, ROOT, TOKEN, V1, V2, free_port, server, wait_capture  # noqa: F401

VNEG = ROOT / "assets" / "videos" / "pexels_5051518.mp4"
pytestmark = pytest.mark.skipif(not (V1.exists() and V2.exists() and VNEG.exists() and PY.exists()),
                                reason="缺少素材或 venv")


@pytest.fixture(scope="module")
def smtpd():
    from aiosmtpd.controller import Controller

    class H:
        msgs = []

        async def handle_DATA(self, server, session, envelope):
            self.msgs.append(email.message_from_bytes(envelope.content, policy=email.policy.default))
            return "250 OK"
    h, port = H(), free_port()
    ctl = Controller(h, hostname="127.0.0.1", port=port)
    ctl.start()
    yield h, port
    ctl.stop()


def wait_for(fn, timeout=45, step=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


def test_v11_full_flow(server, smtpd):
    c = server["c"]
    h, smtp_port = smtpd
    # ---- 1) 采集登记王总（老板）
    sid = c.post("/captures", json={"kind": "file", "uri": str(V1), "duration_s": 8, "fps": 5}).json()["id"]
    cap = wait_capture(c, sid)
    big = max(cap["clusters"], key=lambda x: x["quality_ok"])
    r = c.post(f"/captures/{sid}/clusters/{big['id']}/confirm", json={"action": "enroll", "name": "王总", "role": "boss"})
    assert r.status_code == 200, r.text
    pid = r.json()["person_id"]

    # ---- 2) 邮件设置：授权码加密存储、测试邮件
    s = c.put("/settings", json={"smtp_host": "127.0.0.1", "smtp_port": smtp_port, "smtp_security": "none",
                                 "smtp_from": "boss@shiwu.local", "smtp_to": ["me@example.local"],
                                 "smtp_password": "SECRET-app-code-123", "email_per_hour": 10,
                                 "email_min_interval_s": 0, "snapshot_retention_days": 7}).json()
    assert s["smtp_password_set"] is True and "smtp_password" not in s and "smtp_password_enc" not in s
    raw = (server["dir"] / "boss" / "settings.json").read_text("utf-8")
    assert "SECRET" not in raw and "smtp_password_enc" in raw
    assert c.post("/settings/test-email", json={}).status_code == 200
    assert len(h.msgs) == 1 and "测试邮件" in h.msgs[0]["Subject"]

    # ---- 3) 规则：老板（只看门口，遮挡+邮件，离开 3 s 自动恢复）；陌生人（只看桌面）；白名单
    rules = [{"id": "whitelist", "role": "whitelist", "whitelist": True, "min_frames": 1},
             {"id": "boss", "role": "boss", "min_frames": 2, "cooldown_s": 600, "sources": ["门口"],
              "restore_on_leave": True, "leave_after_s": 3,
              "actions": [{"type": "cover"}, {"type": "email", "params": {"attach_snapshot": True}}]},
             {"id": "stranger", "stranger": True, "stranger_after_s": 2, "min_frames": 3, "cooldown_s": 600,
              "sources": ["桌面"], "actions": [{"type": "log"}]}]
    assert c.put("/rules", json=rules).status_code == 200
    assert c.put("/rules", json=[{"id": "x", "actions": []}]).status_code == 400   # 无对象的规则被拒

    # ---- 4) 两路源并发
    c.post("/monitor/resume")
    assert c.post("/pipeline/start", json={"kind": "file", "uri": str(V2), "loop": False, "name": "门口"}).status_code == 200
    assert c.post("/pipeline/start", json={"kind": "file", "uri": str(VNEG), "loop": False, "name": "桌面"}).status_code == 200
    st = c.get("/pipeline/status").json()
    assert sorted(p["name"] for p in st["pipelines"]) == ["桌面", "门口"] and all(p["running"] for p in st["pipelines"])
    assert wait_for(lambda: all(c.get("/preview.jpg", params={"source": n}).status_code == 200 for n in ("门口", "桌面")), 15)

    def actions():
        return c.get("/eventlog", params={"kind": "action", "limit": 100}).json()
    boss_ev = wait_for(lambda: [e for e in actions() if e["person_id"] == pid])
    assert boss_ev and boss_ev[0]["source"] == "门口" and boss_ev[0]["snapshot"]
    stranger_ev = wait_for(lambda: [e for e in actions() if e["rule_id"] == "stranger"])
    assert stranger_ev and stranger_ev[0]["source"] == "桌面" and stranger_ev[0]["name"] == "陌生人"
    assert not [e for e in actions() if e["person_id"] == pid and e["source"] == "桌面"]   # 规则按源限定

    # 邮件：带快照附件、时间/人员/角色
    mail = wait_for(lambda: [m for m in h.msgs if "王总" in m["Subject"]], 20)
    assert mail, "未收到告警邮件"
    m = mail[0]
    body = m.get_body(("plain",)).get_content()
    assert "老板" in m["Subject"] and "门口" in body and "时间" in body
    att = list(m.iter_attachments())
    assert len(att) == 1 and att[0].get_content_type() == "image/jpeg" and att[0].get_content()[:2] == b"\xff\xd8"
    res = wait_for(lambda: [e for e in c.get("/eventlog", params={"kind": "action_result"}).json()
                            if e["source"] == "server"], 10)
    assert res and res[0]["detail"]["results"][0]["ok"]

    # ---- 5) 离开检测（视频播完 → 3 s 后 left）
    left = wait_for(lambda: [e for e in c.get("/eventlog", params={"kind": "left"}).json() if e["person_id"] == pid], 40)
    assert left and left[0]["detail"]["action_id"]

    # ---- 6) 时间线 + 加密快照
    tl = c.get("/timeline", params={"person_id": pid}).json()
    act = [e for e in tl if e["kind"] == "action"][0]
    assert act["snapshot_url"] and act["role_label"] == "老板"
    img = c.get(act["snapshot_url"].removeprefix("/boss"))
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"
    files = list((server["dir"] / "boss" / "snapshots").glob("*/*.enc"))
    assert files and all(not f.read_bytes().startswith(b"\xff\xd8") for f in files)
    assert any(e["kind"] == "left" for e in tl)
    assert c.get("/timeline", params={"source": "桌面"}).json()[0]["rule_id"] == "stranger"

    # ---- 7) 白名单：王总改为白名单后，同一段视频不再触发
    c.post("/pipeline/stop")
    n_before = len(actions())
    assert c.put(f"/people/{pid}", json={"role": "whitelist"}).status_code == 200
    rules[1]["cooldown_s"] = 0
    c.put("/rules", json=rules)
    c.post("/pipeline/start", json={"kind": "file", "uri": str(V2), "loop": False, "name": "门口"})
    time.sleep(1)
    wait_for(lambda: not c.get("/pipeline/status").json()["running"], 40)
    rec = c.get("/eventlog", params={"kind": "recognized", "limit": 500}).json()
    assert any(e["person_id"] == pid and e["role"] == "whitelist" for e in rec)   # 认出来了
    assert len(actions()) == n_before                                              # 但没有触发

    # ---- 8) 统计 + CSV
    stt = c.get("/stats", params={"days": 7}).json()
    me = [p for p in stt["people"] if p["person_id"] == pid][0]
    assert me["total"] >= 2 and stt["totals"]["triggers"] >= 2 and sum(map(sum, stt["heatmap"])) >= 2
    csv = c.get("/stats/export.csv").text
    assert "王总" in csv and "出现次数" in csv
    assert "门口" in c.get("/sources/names").json()
