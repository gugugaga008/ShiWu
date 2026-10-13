"""EventLog：识别 / 动作 / 监控开关事件持久化（SQLite，data/events.db）。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import List, Optional

from ..paths import data_dir


class EventLog:
    def __init__(self, path: Optional[str] = None, max_rows: int = 20000):
        self.path = str(path or data_dir() / "events.db")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.max_rows = max_rows
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("""CREATE TABLE IF NOT EXISTS event_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL,
            person_id TEXT, name TEXT, role TEXT, rule_id TEXT, track_id INTEGER,
            similarity REAL, actions TEXT, source TEXT, detail TEXT)""")
        self._db.execute("CREATE INDEX IF NOT EXISTS ix_ev_ts ON event_log(ts)")
        cols = [r[1] for r in self._db.execute("PRAGMA table_info(event_log)")]
        if "snapshot" not in cols:
            self._db.execute("ALTER TABLE event_log ADD COLUMN snapshot TEXT")
        self._db.commit()
        self._n = 0

    def add(self, kind: str, *, ts: Optional[float] = None, person_id=None, name=None, role=None,
            rule_id=None, track_id=None, similarity=None, actions=None, source=None, detail=None,
            snapshot=None) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO event_log(ts,kind,person_id,name,role,rule_id,track_id,similarity,actions,source,detail,"
                "snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts or time.time(), kind, person_id, name, role, rule_id, track_id, similarity,
                 json.dumps(actions, ensure_ascii=False) if actions is not None else None, source,
                 json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else detail, snapshot))
            self._n += 1
            if self._n % 500 == 0:  # 滚动保留
                self._db.execute("DELETE FROM event_log WHERE id <= (SELECT MAX(id) FROM event_log) - ?",
                                 (self.max_rows,))
            self._db.commit()
            return int(cur.lastrowid)

    def list(self, limit: int = 100, kind: Optional[str] = None, before_id: Optional[int] = None) -> List[dict]:
        q, args = "SELECT * FROM event_log WHERE 1=1", []
        if kind:
            q += " AND kind IN (%s)" % ",".join("?" * len(kind.split(",")))
            args += kind.split(",")
        if before_id:
            q += " AND id < ?"
            args.append(before_id)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            cur = self._db.execute(q, args)
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        for r in rows:
            for k in ("actions", "detail"):
                if r[k] and r[k][:1] in "[{":
                    r[k] = json.loads(r[k])
        return rows

    def purge_person(self, person_id: str) -> int:
        with self._lock:
            n = self._db.execute("DELETE FROM event_log WHERE person_id=?", (person_id,)).rowcount
            self._db.commit()
            return n

    def close(self):
        self._db.close()
