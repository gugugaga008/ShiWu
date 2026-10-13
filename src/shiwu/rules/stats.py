"""统计：按人/角色/日期的出现次数、星期×小时热力图、触发趋势；CSV 导出。数据来自 event_log。

“出现一次” = 一条轨迹（同一视频源 + track_id + 人员，在当天）被识别。
"""
from __future__ import annotations

import csv
import io
import time
from typing import Optional


def _where(since: float, person: Optional[str], role: Optional[str], source: Optional[str]):
    q, a = " WHERE ts >= ?", [since]
    if person:
        q += " AND person_id = ?"
        a.append(person)
    if role:
        q += " AND role = ?"
        a.append(role)
    if source:
        q += " AND source = ?"
        a.append(source)
    return q, a


def compute(eventlog, days: int = 7, person: Optional[str] = None, role: Optional[str] = None,
            source: Optional[str] = None, now: Optional[float] = None) -> dict:
    now = now or time.time()
    lt = time.localtime(now)
    start_today = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    since = start_today - (days - 1) * 86400
    dates = [time.strftime("%Y-%m-%d", time.localtime(start_today - i * 86400)) for i in range(days - 1, -1, -1)]
    w, a = _where(since, person, role, source)
    app = ("SELECT date(ts,'unixepoch','localtime') d, person_id, MAX(name) name, MAX(role) role,"
           " COUNT(DISTINCT COALESCE(source,'') || '#' || COALESCE(track_id,-1)) n"
           f" FROM event_log{w} AND kind='recognized' AND person_id IS NOT NULL GROUP BY d, person_id")
    heat = ("SELECT CAST(strftime('%w',ts,'unixepoch','localtime') AS INT) wd,"
            " CAST(strftime('%H',ts,'unixepoch','localtime') AS INT) h,"
            " COUNT(DISTINCT date(ts,'unixepoch','localtime') || COALESCE(source,'') || '#' || COALESCE(track_id,-1) || person_id) n"
            f" FROM event_log{w} AND kind='recognized' AND person_id IS NOT NULL GROUP BY wd, h")
    trig = ("SELECT date(ts,'unixepoch','localtime') d, COALESCE(role, CASE WHEN rule_id IS NOT NULL THEN rule_id END) r,"
            f" COUNT(*) n FROM event_log{w} AND kind='action' GROUP BY d, r")
    with eventlog._lock:
        rows_app = eventlog._db.execute(app, a).fetchall()
        rows_heat = eventlog._db.execute(heat, a).fetchall()
        rows_trig = eventlog._db.execute(trig, a).fetchall()
    people: dict = {}
    daily = {d: {"date": d, "appearances": 0, "triggers": 0} for d in dates}
    for d, pid, name, rl, n in rows_app:
        p = people.setdefault(pid, {"person_id": pid, "name": name, "role": rl, "total": 0,
                                    "by_date": {x: 0 for x in dates}})
        p["total"] += n
        if d in p["by_date"]:
            p["by_date"][d] += n
        if d in daily:
            daily[d]["appearances"] += n
    trig_roles: dict = {}
    for d, r, n in rows_trig:
        if d in daily:
            daily[d]["triggers"] += n
            daily[d][f"t_{r or 'other'}"] = daily[d].get(f"t_{r or 'other'}", 0) + n
            trig_roles[r or "other"] = trig_roles.get(r or "other", 0) + n
    # sqlite %w: 0=周日 → 转成 0=周一
    heatmap = [[0] * 24 for _ in range(7)]
    for wd, h, n in rows_heat:
        heatmap[(wd + 6) % 7][h] += n
    return {"days": days, "dates": dates, "daily": list(daily.values()),
            "people": sorted(people.values(), key=lambda p: -p["total"]),
            "heatmap": heatmap, "trigger_roles": trig_roles,
            "totals": {"appearances": sum(x["appearances"] for x in daily.values()),
                       "triggers": sum(x["triggers"] for x in daily.values()),
                       "people": len(people)}}


def to_csv(stats: dict, role_labels: Optional[dict] = None) -> str:
    role_labels = role_labels or {}
    buf = io.StringIO()
    buf.write("\ufeff")  # Excel 识别 UTF-8
    w = csv.writer(buf)
    w.writerow(["日期", "人员", "角色", "出现次数"])
    for p in stats["people"]:
        for d, n in p["by_date"].items():
            if n:
                w.writerow([d, p["name"] or p["person_id"], role_labels.get(p["role"], p["role"] or ""), n])
    w.writerow([])
    w.writerow(["日期", "出现总次数", "触发次数"])
    for d in stats["daily"]:
        w.writerow([d["date"], d["appearances"], d["triggers"]])
    return buf.getvalue()
