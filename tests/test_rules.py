"""RuleEngine / EventLog / 加密多模板库单元测试（不依赖模型）。"""
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

from shiwu.enroll import LocalGallery  # noqa: E402
from shiwu.rules import DEFAULT_RULES, EventLog, RuleEngine, normalize_rules  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def tick(self, dt=0.2):
        self.t += dt


BOSS = {"track_id": 1, "person_id": "P1", "name": "王总", "role": "boss", "similarity": 0.8}
RULES = [{"id": "boss", "role": "boss", "min_frames": 3, "cooldown_s": 10,
          "actions": [{"type": "notify"}, {"type": "cover"}]},
         {"id": "leader", "role": "leader", "min_frames": 1, "cooldown_s": 5, "enabled": False,
          "actions": [{"type": "notify"}]}]


def make(tmp_path=None, rules=RULES):
    c = Clock()
    got = []
    log = EventLog(str(tmp_path / "ev.db")) if tmp_path else None
    return RuleEngine(rules, on_action=got.append, eventlog=log, clock=c), c, got, log


def run(eng, clock, faces, n):
    out = []
    for _ in range(n):
        out += eng.observe(faces)
        clock.tick()
    return out


def test_needs_n_consecutive_frames():
    eng, c, got, _ = make()
    assert run(eng, c, [BOSS], 2) == []
    fired = run(eng, c, [BOSS], 1)
    assert len(fired) == 1 and got == fired
    ev = fired[0]
    assert ev["role"] == "boss" and ev["name"] == "王总" and ev["frames"] == 3
    assert [a["type"] for a in ev["actions"]] == ["notify", "cover"]


def test_cooldown_debounce_and_refire_after_cooldown():
    eng, c, got, _ = make()
    run(eng, c, [BOSS], 20)          # 4 秒内只触发一次
    assert len(got) == 1
    c.tick(10)                       # 冷却已过，但中断后需重新累计 N 帧
    run(eng, c, [BOSS], 2)
    assert len(got) == 1
    run(eng, c, [BOSS], 1)
    assert len(got) == 2


def test_cooldown_is_per_person_not_per_track():
    eng, c, got, _ = make()
    run(eng, c, [BOSS], 3)
    run(eng, c, [dict(BOSS, track_id=7)], 5)   # 同一人换了轨迹 → 仍在冷却
    assert len(got) == 1
    run(eng, c, [dict(BOSS, track_id=8, person_id="P2", name="另一位老板")], 3)
    assert len(got) == 2


def test_identity_switch_or_gap_resets_streak():
    eng, c, got, _ = make()
    run(eng, c, [BOSS], 2)
    run(eng, c, [dict(BOSS, person_id="PX", role=None)], 1)  # 同轨迹身份变了
    run(eng, c, [BOSS], 2)
    assert got == []
    c.tick(5)                                               # 中断超过 gap_s
    run(eng, c, [BOSS], 2)
    assert got == []
    run(eng, c, [BOSS], 1)
    assert len(got) == 1


def test_unknown_faces_and_roles_without_rule_ignored():
    eng, c, got, _ = make()
    run(eng, c, [{"track_id": 2, "person_id": None, "role": None}], 10)
    run(eng, c, [dict(BOSS, track_id=3, role="leader")], 10)   # leader 规则未启用
    run(eng, c, [dict(BOSS, track_id=4, role="staff")], 10)    # 无规则
    run(eng, c, [dict(BOSS, track_id=None)], 10)               # 无轨迹
    assert got == []


def test_pause_resume(tmp_path):
    eng, c, got, log = make(tmp_path)
    eng.pause("tray")
    run(eng, c, [BOSS], 10)
    assert got == []
    eng.resume("tray")
    run(eng, c, [BOSS], 2)
    assert got == []           # 恢复后重新计数
    run(eng, c, [BOSS], 1)
    assert len(got) == 1
    kinds = [r["kind"] for r in log.list()]
    assert kinds == ["action", "monitor_resumed", "monitor_paused"]


def test_eventlog_records_actions_and_purge(tmp_path):
    eng, c, got, log = make(tmp_path)
    run(eng, c, [BOSS], 3)
    rows = log.list(kind="action")
    assert len(rows) == 1 and rows[0]["person_id"] == "P1" and rows[0]["role"] == "boss"
    assert rows[0]["actions"][0]["type"] == "notify"
    log.add("recognized", person_id="P1", name="王总")
    assert log.purge_person("P1") == 2
    assert log.list() == []


def test_set_rules_takes_effect():
    eng, c, got, _ = make()
    eng.set_rules([dict(RULES[0], min_frames=1)])
    run(eng, c, [BOSS], 1)
    assert len(got) == 1


def test_normalize_legacy_and_defaults():
    r = normalize_rules([{"role": "boss", "action": "alert"}, {"role": "x", "actions": [{"type": "rm_rf"}]}])
    assert [a["type"] for a in r[0]["actions"]] == ["notify", "sound", "cover"]
    assert r[0]["id"] == "boss" and r[0]["min_confirm_s"] == 0.5 and r[0]["min_frames"] == 3
    assert r[0]["cooldown_s"] == 30
    assert r[1]["actions"] == []                         # 未知动作被丢弃
    d = normalize_rules(DEFAULT_RULES)
    assert len(d) == 1 and d[0]["id"] == "boss" and d[0]["min_confirm_s"] == 0.5
    assert {a["type"] for a in d[0]["actions"]} >= {"notify", "cover", "minimize_all"}
    only_frames = normalize_rules([{"role": "boss", "min_frames": 1}, {"role": "boss", "min_frames": 3}])
    assert only_frames[0]["min_confirm_s"] == 0 and only_frames[1]["min_confirm_s"] == 0.4


# ---------- 加密多模板库 ----------
def fake_cipher():
    k = 0x5A
    enc = lambda b: b"IV" + bytes(x ^ k for x in b)       # noqa: E731
    dec = lambda b: bytes(x ^ k for x in b[2:])            # noqa: E731
    return enc, dec


def test_gallery_encrypts_and_migrates_plaintext(tmp_path):
    p = str(tmp_path / "g.db")
    e = np.random.default_rng(0).normal(size=512).astype(np.float32)
    e /= np.linalg.norm(e)
    g0 = LocalGallery(p, cipher=None)                       # 旧版：明文
    g0.add("P1", e)
    g0.close()
    raw = sqlite3.connect(p).execute("SELECT embedding, enc FROM templates").fetchone()
    assert raw[1] == 0 and raw[0] == e.tobytes()
    g = LocalGallery(p, cipher=fake_cipher())               # 启动时迁移
    raw = sqlite3.connect(p).execute("SELECT embedding, enc FROM templates").fetchone()
    assert raw[1] == 1 and raw[0] != e.tobytes()
    g.add("P1", e)
    M, ids = g.matrix()
    assert ids == ["P1", "P1"] and np.allclose(M @ e, 1.0, atol=1e-5)


def test_gallery_remove_person_leaves_no_trace(tmp_path):
    p = str(tmp_path / "g.db")
    g = LocalGallery(p, cipher=None)
    e = np.ones(512, np.float32)
    for _ in range(5):
        g.add("GONE", e)
    g.add("KEEP", -e)
    assert g.remove_person("GONE") == 5
    g.close()
    data = Path(p).read_bytes()
    marker = (e / np.linalg.norm(e)).tobytes()[:64]
    assert marker not in data and b"GONE" not in data       # VACUUM 后文件里无残留
    assert LocalGallery(p, cipher=None).count() == {"KEEP": 1}
