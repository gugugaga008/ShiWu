"""v1.1 规则增强：人员/时间段/距离/源/优先级、白名单抑制、陌生人、离开检测。"""
import datetime as dt
import time

from shiwu.rules import RuleEngine
from shiwu.rules.conditions import in_schedule, near_enough


class Clock:
    def __init__(self, t=None):
        self.t = t or time.mktime(dt.datetime(2026, 10, 12, 10, 0).timetuple())  # 周一 10:00

    def __call__(self):
        return self.t


def face(tid, pid=None, role=None, w=120, fw=1280, name=None):
    return {"track_id": tid, "person_id": pid, "role": role, "name": name or pid, "similarity": 0.8,
            "face_w": w, "frame_w": fw}


def act(a="notify"):
    return [{"type": a, "params": {}}]


def run(eng, clock, frames, source="main", dt_=0.2):
    out = []
    for fs in frames:
        out += eng.observe(fs, source)
        clock.t += dt_
    return out


def test_schedule_and_overnight():
    mon10 = time.mktime(dt.datetime(2026, 10, 12, 10, 0).timetuple())
    sat10 = time.mktime(dt.datetime(2026, 10, 17, 10, 0).timetuple())
    tue3 = time.mktime(dt.datetime(2026, 10, 13, 3, 0).timetuple())
    work = [{"days": [0, 1, 2, 3, 4], "start": "09:00", "end": "18:00"}]
    assert in_schedule(work, mon10) and not in_schedule(work, sat10)
    night = [{"days": [0], "start": "22:00", "end": "06:00"}]   # 周一夜 → 周二凌晨
    assert in_schedule(night, tue3) and not in_schedule(night, mon10)
    assert in_schedule([], sat10)


def test_distance():
    assert near_enough({"min_face_px": 100}, {"face_w": 120, "frame_w": 1280})
    assert not near_enough({"min_face_px": 150}, {"face_w": 120, "frame_w": 1280})
    assert not near_enough({"min_face_ratio": 0.2}, {"face_w": 120, "frame_w": 1280})
    assert near_enough({"min_face_ratio": 0.05}, {"face_w": 120, "frame_w": 1280})


def test_person_rule_beats_role_rule_by_priority():
    c = Clock()
    rules = [{"id": "boss", "role": "boss", "min_frames": 2, "cooldown_s": 60, "actions": act("notify")},
             {"id": "wang", "person_ids": ["p1"], "min_frames": 2, "cooldown_s": 60, "actions": act("cover")}]
    e = RuleEngine(rules, clock=c)
    out = run(e, c, [[face(1, "p1", "boss")]] * 3 + [[face(2, "p2", "boss")]] * 3)
    assert [o["rule_id"] for o in out] == ["wang", "boss"]


def test_schedule_distance_source_conditions():
    c = Clock()
    rules = [{"id": "door", "role": "boss", "min_frames": 1, "cooldown_s": 0, "actions": act(),
              "sources": ["门口"], "min_face_px": 100,
              "schedule": [{"days": [5, 6], "start": "00:00", "end": "24:00"}]}]
    e = RuleEngine(rules, clock=c)
    assert run(e, c, [[face(1, "p1", "boss")]], "门口") == []           # 周一不在时间段
    c.t += 5 * 86400                                                   # 周六
    assert run(e, c, [[face(1, "p1", "boss", w=60)]], "门口") == []     # 太远
    assert run(e, c, [[face(1, "p1", "boss")]], "桌面") == []           # 源不符
    assert len(run(e, c, [[face(1, "p1", "boss")]], "门口")) == 1


def test_whitelist_no_trigger_and_suppress():
    c = Clock()
    rules = [{"id": "wl", "role": "whitelist", "whitelist": True, "suppress_others": False, "min_frames": 1},
             {"id": "boss", "role": "boss", "min_frames": 2, "cooldown_s": 0, "actions": act()},
             {"id": "s", "stranger": True, "stranger_after_s": 0, "min_frames": 1, "cooldown_s": 0, "actions": act()}]
    e = RuleEngine(rules, clock=c)
    assert run(e, c, [[face(1, "w1", "whitelist")]] * 5) == []         # 同事路过不触发
    out = run(e, c, [[face(1, "w1", "whitelist"), face(2, "b", "boss")]] * 2)
    assert [o["rule_id"] for o in out] == ["boss"]                     # 不抑制时老板照常触发
    rules[0]["suppress_others"] = True
    e2 = RuleEngine(rules, clock=c)
    assert run(e2, c, [[face(1, "w1", "whitelist"), face(2, "b", "boss")]] * 4) == []
    assert e2.suppressed > 0


def test_stranger_after_n_seconds():
    c = Clock()
    rules = [{"id": "s", "stranger": True, "stranger_after_s": 3, "min_frames": 3, "cooldown_s": 60, "actions": act()}]
    e = RuleEngine(rules, clock=c)
    assert run(e, c, [[face(7)]] * 10, dt_=0.25) == []                  # 2.5 s
    out = run(e, c, [[face(7)]] * 4, dt_=0.25)
    assert len(out) == 1 and out[0]["stranger"] and out[0]["name"] == "陌生人"
    # 被识别出的人不算陌生人；识别后轨迹的陌生计时清零
    c2 = Clock()
    e2 = RuleEngine(rules, clock=c2)
    assert run(e2, c2, [[face(8)]] * 8 + [[face(8, "p1", "boss")]] * 20, dt_=0.25) == []


def test_leave_detection():
    c = Clock()
    rules = [{"id": "boss", "role": "boss", "min_frames": 1, "cooldown_s": 600, "actions": act("cover"),
              "restore_on_leave": True, "leave_after_s": 5}]
    left = []
    e = RuleEngine(rules, clock=c, on_leave=left.append)
    fired = run(e, c, [[face(1, "b", "boss")]] * 5)
    assert len(fired) == 1
    run(e, c, [[]] * 10, dt_=0.4)                                       # 4 s：还没走远
    assert left == []
    run(e, c, [[face(3, "b", "boss")]] * 2)                             # 回来了（新轨迹也算）
    run(e, c, [[]] * 10, dt_=0.4)
    assert left == []
    c.t += 2
    e.tick()
    assert len(left) == 1 and left[0]["action_id"] == fired[0]["id"] and left[0]["away_s"] >= 5


def test_streak_isolated_per_source():
    c = Clock()
    e = RuleEngine([{"id": "boss", "role": "boss", "min_frames": 3, "cooldown_s": 0, "actions": act()}], clock=c)
    out = []
    for _ in range(2):       # 两路源交替、同一 track_id：各自只有 2 帧，不应触发
        out += e.observe([face(1, "b", "boss")], "A")
        out += e.observe([face(1, "b", "boss")], "B")
        c.t += 0.2
    assert out == []
    out += e.observe([face(1, "b", "boss")], "A")
    assert [o["source"] for o in out] == ["A"]


def test_person_rule_event_carries_face_role():
    c = Clock()
    e = RuleEngine([{"id": "wang", "person_ids": ["p1"], "min_frames": 1, "cooldown_s": 0, "actions": act()}], clock=c)
    assert run(e, c, [[face(1, "p1", "boss")]])[0]["role"] == "boss"
