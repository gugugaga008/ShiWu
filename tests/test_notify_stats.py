"""v1.1：快照加密存储/保留、邮件（本地 aiosmtpd）、限流、统计、多路共享引擎。"""
import datetime as dt
import email
import socket
import threading
import time

import numpy as np
import pytest

from shiwu.notify import Mailer, RateLimiter, SmtpConfig, SnapshotStore, build_alert_email
from shiwu.rules import EventLog
from shiwu.rules.stats import compute, to_csv
from shiwu.stream.shared import SharedEngineView

JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200 + b"\xff\xd9"
XOR = (lambda b: bytes(x ^ 0x5A for x in b), lambda b: bytes(x ^ 0x5A for x in b))


def test_snapshot_encrypted_roundtrip_and_purge(tmp_path):
    s = SnapshotStore(tmp_path, cipher=XOR)
    sid = s.save(JPEG)
    raw = next(tmp_path.glob("*/*.enc")).read_bytes()
    assert raw != JPEG and not raw.startswith(b"\xff\xd8")   # 落盘是密文
    assert s.load(sid) == JPEG and s.exists(sid)
    with pytest.raises(KeyError):
        s.load("../../etc/passwd")
    old = s.save(JPEG, ts=time.time() - 40 * 86400)
    assert s.purge(30) == 1 and not s.exists(old) and s.exists(sid)
    assert s.purge(0) == 0
    assert s.stats()["count"] == 1 and s.delete(sid) and not s.exists(sid)


def test_rate_limiter():
    t = [1000.0]
    r = RateLimiter(per_hour=3, min_interval_s=60, clock=lambda: t[0])
    assert r.allow()[0]
    t[0] += 10
    ok, why = r.allow()
    assert not ok and "60" in why
    for _ in range(2):
        t[0] += 61
        assert r.allow()[0]
    t[0] += 61
    ok, why = r.allow()
    assert not ok and "每小时" in why and r.dropped == 2
    t[0] += 3600
    assert r.allow()[0]


def test_alert_email_content():
    cfg = SmtpConfig(host="h", sender="a@x.local", recipients=["b@x.local", "c@x.local"])
    ev = {"ts": time.time(), "name": "王总", "role": "boss", "rule_id": "boss", "source": "门口", "similarity": 0.77}
    m = build_alert_email(cfg, ev, JPEG, "老板")
    assert "王总" in m["Subject"] and "老板" in m["Subject"]
    body = m.get_body(("plain",)).get_content()
    assert "门口" in body and "0.77" in body and "时间" in body
    att = list(m.iter_attachments())
    assert len(att) == 1 and att[0].get_content_type() == "image/jpeg" and att[0].get_content() == JPEG
    assert SmtpConfig().problems() and not cfg.problems()
    assert any("ASCII" in p for p in SmtpConfig(host="h", sender="a", recipients=["b"], password="授权码").problems())
    assert SmtpConfig.from_settings({"smtp_host": "h", "smtp_to": "a@x; b@x", "smtp_user": "u@x"}).recipients == ["a@x", "b@x"]


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture
def smtpd():
    from aiosmtpd.controller import Controller

    class H:
        def __init__(self):
            self.msgs = []

        async def handle_DATA(self, server, session, envelope):
            self.msgs.append((envelope.mail_from, list(envelope.rcpt_tos), envelope.content))
            return "250 OK"
    h = H()
    port = _free_port()
    ctl = Controller(h, hostname="127.0.0.1", port=port)
    ctl.start()
    yield h, port
    ctl.stop()


def test_mailer_sends_to_local_smtpd(smtpd):
    h, port = smtpd
    cfg = SmtpConfig(host="127.0.0.1", port=port, security="none", sender="boss@x.local", recipients=["me@x.local"])
    msg = build_alert_email(cfg, {"ts": time.time(), "name": "王总", "role": "boss"}, JPEG, "老板")
    assert "me@x.local" in Mailer().send(cfg, msg)
    assert len(h.msgs) == 1 and h.msgs[0][1] == ["me@x.local"]
    m = email.message_from_bytes(h.msgs[0][2], policy=email.policy.default)
    assert "王总" in m["Subject"]
    assert [p.get_content_type() for p in m.iter_attachments()] == ["image/jpeg"]
    with pytest.raises(ValueError):
        Mailer().send(SmtpConfig(), msg)


def _today(h, m=0, days_ago=0):
    d = dt.datetime.now().replace(hour=h, minute=m, second=0, microsecond=0) - dt.timedelta(days=days_ago)
    return d.timestamp()


def test_stats_and_csv(tmp_path):
    el = EventLog(tmp_path / "e.db")
    # 王总今天在门口出现 2 条轨迹（同轨迹多条识别事件只算 1 次），昨天 1 次；小李今天 1 次；2 次触发
    for ts, tid in [(_today(9), 1), (_today(9, 5), 1), (_today(14), 2)]:
        el.add("recognized", ts=ts, person_id="p1", name="王总", role="boss", track_id=tid, source="门口")
    el.add("recognized", ts=_today(10, days_ago=1), person_id="p1", name="王总", role="boss", track_id=1, source="门口")
    el.add("recognized", ts=_today(11), person_id="p2", name="小李", role="staff", track_id=9, source="桌面")
    el.add("action", ts=_today(9, 1), person_id="p1", name="王总", role="boss", rule_id="boss", source="门口")
    el.add("action", ts=_today(10, 1, 1), person_id="p1", name="王总", role="boss", rule_id="boss", source="门口")
    # 测试动作不应计入触发次数
    el.add("action", ts=_today(12), person_id=None, name="测试", role="boss", rule_id="boss", source="test")
    el.add("recognized", ts=_today(9, days_ago=30), person_id="p1", name="王总", role="boss", track_id=5, source="门口")
    s = compute(el, days=7)
    assert s["totals"] == {"appearances": 4, "triggers": 2, "people": 2}
    p1 = s["people"][0]
    assert p1["name"] == "王总" and p1["total"] == 3 and p1["by_date"][s["dates"][-1]] == 2
    wd = dt.datetime.now().weekday()
    assert s["heatmap"][wd][9] == 1 and s["heatmap"][wd][14] == 1
    assert s["daily"][-1]["triggers"] == 1 and s["daily"][-1]["t_boss"] == 1
    assert compute(el, 7, role="staff")["totals"]["appearances"] == 1
    assert compute(el, 7, source="门口")["totals"]["people"] == 1
    csv = to_csv(s, {"boss": "老板"})
    assert csv.startswith("\ufeff") and "王总,老板,2" in csv


class FakeBase:
    enable_tracking = True

    def __init__(self):
        self.tracker = "base"
        self.calls, self.busy, self.overlap = [], False, False

    def _new_tracker(self):
        return object()

    def process(self, image, frame_rate=None):
        if self.busy:
            self.overlap = True
        self.busy = True
        time.sleep(0.005)
        self.calls.append(self.tracker)
        self.busy = False
        return []


def test_shared_engine_view_isolates_trackers_and_serializes():
    base = FakeBase()
    lock = threading.Lock()
    a, b = SharedEngineView(base, lock), SharedEngineView(base, lock)
    img = np.zeros((4, 4, 3), np.uint8)
    ts = [threading.Thread(target=lambda v=v: [v.process(img) for _ in range(20)]) for v in (a, b)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not base.overlap and base.tracker == "base"
    assert base.calls.count(a.tracker) == 20 and base.calls.count(b.tracker) == 20
    old = a.tracker
    a.reset()
    assert a.tracker is not old
