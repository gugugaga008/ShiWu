"""规则条件：人员 / 角色 / 陌生人 / 视频源 / 时间段（星期+时间窗）/ 距离（人脸宽度、占画面比例）。

纯函数，便于单测。时间按本机本地时区解释。
"""
from __future__ import annotations

import datetime as _dt
from typing import List, Optional

WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]  # 0=周一


def _minutes(hhmm: str) -> int:
    h, m = (str(hhmm or "0:0").split(":") + ["0"])[:2]
    return max(0, min(24 * 60, int(h) * 60 + int(m)))


def in_schedule(schedule: Optional[List[dict]], ts: float) -> bool:
    """schedule 为空 = 全天候；任一时间窗命中即可。end<start 表示跨夜（如 22:00–06:00，跨夜部分算前一天的星期）。"""
    if not schedule:
        return True
    t = _dt.datetime.fromtimestamp(ts)
    wd, mins = t.weekday(), t.hour * 60 + t.minute
    for w in schedule:
        days = w.get("days")
        days = list(range(7)) if days is None or len(days) == 0 else [int(d) for d in days]
        s, e = _minutes(w.get("start", "00:00")), _minutes(w.get("end", "24:00"))
        if s <= e:
            if wd in days and s <= mins < e:
                return True
        else:  # 跨夜
            if (wd in days and mins >= s) or (((wd - 1) % 7) in days and mins < e):
                return True
    return False


def near_enough(rule: dict, face: dict) -> bool:
    """距离条件：人脸宽度 ≥ min_face_px，且占画面宽度比例 ≥ min_face_ratio（0 表示不限）。"""
    w = float(face.get("face_w") or 0)
    fw = float(face.get("frame_w") or 0)
    if rule.get("min_face_px") and w < float(rule["min_face_px"]):
        return False
    if rule.get("min_face_ratio") and (fw <= 0 or w / fw < float(rule["min_face_ratio"])):
        return False
    return True


def source_ok(rule: dict, source: Optional[str]) -> bool:
    srcs = rule.get("sources") or []
    return not srcs or (source in srcs)


def who_matches(rule: dict, face: dict) -> bool:
    pid = face.get("person_id")
    if rule.get("stranger"):
        return not pid
    if not pid:
        return False
    if rule.get("person_ids"):
        if pid not in rule["person_ids"]:
            return False
        return not rule.get("role") or rule["role"] == face.get("role")
    return bool(rule.get("role")) and rule["role"] == face.get("role")


def matches(rule: dict, face: dict, source: Optional[str], ts: float) -> bool:
    return (rule.get("enabled", True) and who_matches(rule, face) and source_ok(rule, source)
            and in_schedule(rule.get("schedule"), ts) and near_enough(rule, face))


def describe(rule: dict) -> str:
    parts = []
    if rule.get("schedule"):
        for w in rule["schedule"]:
            d = w.get("days") or list(range(7))
            parts.append("周" + "".join(WEEKDAYS[i] for i in d) + f" {w.get('start','00:00')}–{w.get('end','24:00')}")
    if rule.get("min_face_px"):
        parts.append(f"脸宽≥{rule['min_face_px']}px")
    if rule.get("min_face_ratio"):
        parts.append(f"占画面≥{round(rule['min_face_ratio']*100)}%")
    if rule.get("sources"):
        parts.append("源：" + "、".join(rule["sources"]))
    return "；".join(parts)
