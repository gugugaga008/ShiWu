"""RuleEngine：识别结果 → 条件匹配（优先级）→ 连续确认 → 冷却去抖 → action 事件；离开检测 → leave 事件。

规则类型（可并存，按 priority 从高到低，每张脸只取第一条条件命中的规则）：
- 角色规则：role
- 人员规则：person_ids（可再限定 role）
- 陌生人规则：stranger=True，未登记人脸在同一轨迹上持续 stranger_after_s 秒仍未识别则触发
- 白名单：whitelist=True，命中者不触发；suppress_others=True 时同一画面里其他人的规则也被抑制
附加条件：sources（视频源）、schedule（星期+时间窗）、min_face_px / min_face_ratio（距离）。
离开自动恢复：restore_on_leave=True 的规则触发后，触发人在该源离开画面超过 leave_after_s 秒 → on_leave。
"""
from __future__ import annotations

import threading
import time
import uuid
from typing import Callable, Dict, List, Optional, Tuple

from .conditions import matches

ACTION_TYPES = {
    "notify": "系统通知",
    "sound": "声音提醒",
    "cover": "全屏遮挡（假装工作）",
    "minimize_all": "最小化所有窗口",
    "focus_app": "切换到指定程序",
    "mute": "静音",
    "lock_screen": "锁屏",
    "command": "运行自定义命令",
    "email": "发送邮件（带快照）",
    "log": "仅记录",
}
SERVER_ACTIONS = {"email"}   # 由服务端执行的动作；其余由桌面端执行

DEFAULT_RULES: List[dict] = [
    {"id": "boss", "role": "boss", "enabled": True, "min_confirm_s": 0.5, "cooldown_s": 30, "priority": 10,
     "restore_on_leave": False, "leave_after_s": 15,
     "actions": [{"type": "notify", "params": {}}, {"type": "sound", "params": {}},
                 {"type": "cover", "params": {"style": "spreadsheet"}},
                 {"type": "minimize_all", "params": {}}],
     "note": "识别到老板"},
]


def _num(v, d, lo=0.0):
    try:
        return max(lo, float(v))
    except (TypeError, ValueError):
        return d


def normalize_rules(rules: List[dict]) -> List[dict]:
    """兼容旧格式（{role, action}），补全默认字段。"""
    legacy = {"alert": ["notify", "sound", "cover"], "notify": ["notify"], "minimize": ["minimize_all"],
              "log": ["log"], "none": []}
    out = []
    for i, r in enumerate(rules):
        r = dict(r)
        if "actions" not in r:
            r["actions"] = [{"type": t, "params": {}} for t in legacy.get(r.pop("action", "none"), [])]
        r.pop("action", None)
        r["id"] = r.get("id") or r.get("role") or f"rule{i}"
        r.setdefault("enabled", True)
        r["role"] = r.get("role") or None
        r["person_ids"] = [str(p) for p in (r.get("person_ids") or [])]
        r["stranger"] = bool(r.get("stranger"))
        r["whitelist"] = bool(r.get("whitelist"))
        r["suppress_others"] = bool(r.get("suppress_others")) and r["whitelist"]
        default_pri = 100 if r["whitelist"] else 50 if r["person_ids"] else 5 if r["stranger"] else 10
        r["priority"] = int(r["priority"]) if r.get("priority") is not None else default_pri
        if r.get("min_confirm_s") is not None:
            r["min_confirm_s"] = _num(r.get("min_confirm_s"), 0.5)
            r["min_frames"] = max(1, int(round(r["min_confirm_s"] * 5) + 1))
        elif r.get("min_frames") is not None:
            r["min_frames"] = max(1, int(r["min_frames"]))
            r["min_confirm_s"] = 0.0 if r["min_frames"] <= 1 else (r["min_frames"] - 1) / 5.0
        else:
            r["min_confirm_s"] = 0.5
            r["min_frames"] = max(1, int(round(0.5 * 5) + 1))
        r["cooldown_s"] = _num(r.get("cooldown_s", 30), 30)
        r["stranger_after_s"] = _num(r.get("stranger_after_s", 5), 5)
        r["sources"] = [str(s) for s in (r.get("sources") or [])]
        r["schedule"] = [{"days": [int(d) for d in (w.get("days") or [])], "start": w.get("start") or "00:00",
                          "end": w.get("end") or "24:00"} for w in (r.get("schedule") or [])]
        r["min_face_px"] = int(_num(r.get("min_face_px", 0), 0))
        r["min_face_ratio"] = min(1.0, _num(r.get("min_face_ratio", 0), 0))
        mode = str(r.get("min_face_mode") or "")
        r["min_face_mode"] = mode if mode in ("", "px", "ratio") else ""
        r["restore_on_leave"] = bool(r.get("restore_on_leave"))
        r["leave_after_s"] = _num(r.get("leave_after_s", 15), 15, 1.0)
        r["actions"] = [{"type": a["type"], "params": dict(a.get("params") or {})}
                        for a in r["actions"] if a.get("type") in ACTION_TYPES]
        if r["whitelist"]:
            r["actions"] = []
        out.append(r)
    return out


class RuleEngine:
    def __init__(self, rules: Optional[List[dict]] = None,
                 on_action: Optional[Callable[[dict], None]] = None,
                 eventlog=None, clock: Callable[[], float] = time.time, gap_s: float = 2.0,
                 on_prepare: Optional[Callable[[dict], None]] = None,
                 on_leave: Optional[Callable[[dict], None]] = None):
        self.rules = normalize_rules(rules if rules is not None else DEFAULT_RULES)
        self.on_action, self.on_prepare, self.on_leave = on_action, on_prepare, on_leave
        self.eventlog = eventlog
        self.clock = clock
        self.gap_s = gap_s
        self.paused = False
        self._lock = threading.Lock()
        # (source, track_id) → [person_id, count, last_ts, first_ts]
        self._streak: Dict[Tuple, list] = {}
        self._last_fire: Dict[Tuple[str, str], float] = {}
        self._active: Dict[Tuple, dict] = {}   # (rule_id, who, source) → {ev, last_seen}
        self.fired = 0
        self.suppressed = 0

    # ---------- 配置 ----------
    def set_rules(self, rules: List[dict]):
        with self._lock:
            self.rules = normalize_rules(rules)

    def ordered(self) -> List[dict]:
        return sorted([r for r in self.rules if r["enabled"]], key=lambda r: -r["priority"])

    def rule_for(self, role: Optional[str]) -> Optional[dict]:
        if not role:
            return None
        for r in self.ordered():
            if r["role"] == role and not r["whitelist"] and not r["stranger"]:
                return r
        return None

    def rule_by_id(self, rid: str) -> Optional[dict]:
        return next((r for r in self.rules if r["id"] == rid), None)

    def pause(self, source: str = "api"):
        self.paused = True
        if self.eventlog:
            self.eventlog.add("monitor_paused", source=source)

    def resume(self, source: str = "api"):
        self.paused = False
        with self._lock:
            self._streak.clear()
        if self.eventlog:
            self.eventlog.add("monitor_resumed", source=source)

    def reset(self, source: Optional[str] = None):
        with self._lock:
            for k in [k for k in self._streak if source is None or k[0] == source]:
                del self._streak[k]

    def reset_cooldowns(self):
        with self._lock:
            self._last_fire.clear()

    # ---------- 主入口 ----------
    def observe(self, faces: List[dict], source: Optional[str] = None) -> List[dict]:
        """faces：[{track_id, person_id, name, role, similarity, face_w, frame_w}]；返回本次触发的 action 事件。"""
        now = self.clock()
        fired: List[dict] = []
        with self._lock:
            seen, present = set(), set()
            plan = []
            rules = self.ordered()
            for f in faces:
                tid, pid = f.get("track_id"), f.get("person_id")
                if tid is None:
                    continue
                key = (source, tid)
                seen.add(key)
                present.add(pid or f"track:{tid}")
                prev = self._streak.get(key)
                if prev and prev[0] == pid and now - prev[2] <= self.gap_s:
                    prev[1] += 1
                    prev[2] = now
                else:
                    first = prev[3] if (prev and now - prev[2] <= self.gap_s and not pid and not prev[0]) else now
                    prev = [pid, 1, now, first]
                    self._streak[key] = prev
                rule = next((r for r in rules if matches(r, f, source, now)), None)
                plan.append((f, rule, prev))
            suppress = any(r and r["whitelist"] and r["suppress_others"]
                           and now - st[3] >= r["min_confirm_s"]
                           for _, r, st in plan)
            for f, rule, st in plan:
                if rule is None or rule["whitelist"] or self.paused:
                    continue
                if suppress:
                    self.suppressed += 1
                    continue
                if now - st[3] < rule["min_confirm_s"]:
                    continue
                if rule["stranger"] and now - st[3] < rule["stranger_after_s"]:
                    continue
                who = "stranger" if rule["stranger"] else f["person_id"]
                ck = (rule["id"], who)
                last = self._last_fire.get(ck)
                if last is not None and now - last < rule["cooldown_s"]:
                    continue
                self._last_fire[ck] = now
                ev = {"id": uuid.uuid4().hex[:12], "ts": now, "rule_id": rule["id"], "role": f.get("role") or rule["role"],
                      "person_id": f.get("person_id"), "name": f.get("name") or ("陌生人" if rule["stranger"] else None),
                      "track_id": f.get("track_id"), "similarity": round(float(f.get("similarity") or 0), 3),
                      "frames": st[1], "actions": rule["actions"], "source": source,
                      "stranger": rule["stranger"], "restore_on_leave": rule["restore_on_leave"],
                      "leave_after_s": rule["leave_after_s"], "bbox": f.get("bbox")}
                if rule["restore_on_leave"]:
                    pk = f.get("person_id") or f"track:{f.get('track_id')}"
                    self._active[(rule["id"], pk, source)] = {"ev": ev, "last_seen": now}
                fired.append(ev)
            for k in [k for k, v in self._streak.items()
                      if k not in seen and (source is None or k[0] == source) and now - v[2] > self.gap_s]:
                del self._streak[k]
            # 离开检测
            for k, a in self._active.items():
                if k[2] == source and k[1] in present:
                    a["last_seen"] = now
            left = self._collect_left(now)
        for ev in fired:
            self.fired += 1
            if self.on_prepare:
                self.on_prepare(ev)
            if self.eventlog:
                self.eventlog.add("action", ts=ev["ts"], person_id=ev["person_id"], name=ev["name"],
                                  role=ev["role"], rule_id=ev["rule_id"], track_id=ev["track_id"],
                                  similarity=ev["similarity"], actions=ev["actions"], source=source,
                                  snapshot=ev.get("snapshot"), detail={"event_id": ev["id"]})
            if self.on_action:
                self.on_action(ev)
        self._emit_left(left)
        return fired

    def tick(self) -> List[dict]:
        """没有新帧时（源停止/卡住）也能检测离开。"""
        with self._lock:
            left = self._collect_left(self.clock())
        self._emit_left(left)
        return left

    def _collect_left(self, now: float) -> List[dict]:
        left = []
        for k in list(self._active):
            a = self._active[k]
            ev = a["ev"]
            if now - a["last_seen"] >= ev["leave_after_s"]:
                del self._active[k]
                left.append({"id": uuid.uuid4().hex[:12], "ts": now, "action_id": ev["id"],
                             "rule_id": ev["rule_id"], "person_id": ev["person_id"], "name": ev["name"],
                             "role": ev["role"], "source": ev["source"], "away_s": round(now - a["last_seen"], 1),
                             "actions": ev["actions"]})
        return left

    def _emit_left(self, left: List[dict]):
        for lv in left:
            if self.eventlog:
                self.eventlog.add("left", ts=lv["ts"], person_id=lv["person_id"], name=lv["name"], role=lv["role"],
                                  rule_id=lv["rule_id"], source=lv["source"],
                                  detail={"action_id": lv["action_id"], "away_s": lv["away_s"]})
            if self.on_leave:
                self.on_leave(lv)

    def active(self) -> List[dict]:
        return [dict(rule_id=k[0], who=k[1], source=k[2], last_seen=v["last_seen"]) for k, v in self._active.items()]
