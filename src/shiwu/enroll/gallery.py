"""多模板人脸库（识务自有，SQLite）。

成员表每人只关联 1 个主模板（upsert），这里补充「每人多张照片」：
- person_id 与成员表 person_id 一致（姓名仍由成员表管理）。
- 识别时取「每人所有模板的最大相似度」。
- embedding 用 core.cipher.encrypt_local_data（AES-256-GCM + 机器密钥）加密后存储；
  旧版明文行在启动时自动迁移（enc=0 → 1）。单元测试可注入 cipher。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from ..paths import data_dir

Cipher = Tuple[Callable[[bytes], bytes], Callable[[bytes], bytes]]


def local_cipher() -> Optional[Cipher]:
    """复用本地数据加密（走 core.cipher 的机器密钥）。"""
    try:
        from shiwu.core.cipher import decrypt_local_data, encrypt_local_data  # type: ignore
        return encrypt_local_data, decrypt_local_data
    except Exception:
        return None


class LocalGallery:
    def __init__(self, path: Optional[str] = None, cipher="auto"):
        self.cipher: Optional[Cipher] = local_cipher() if cipher == "auto" else cipher
        self.path = str(path or data_dir() / "templates.db")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("""CREATE TABLE IF NOT EXISTS templates(
            id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, name TEXT,
            embedding BLOB NOT NULL, dim INTEGER NOT NULL, quality TEXT, source TEXT,
            created_at REAL NOT NULL)""")
        self._db.execute("CREATE INDEX IF NOT EXISTS ix_t_person ON templates(person_id)")
        cols = [r[1] for r in self._db.execute("PRAGMA table_info(templates)")]
        if "enc" not in cols:
            self._db.execute("ALTER TABLE templates ADD COLUMN enc INTEGER NOT NULL DEFAULT 0")
        self._db.commit()
        self._migrate_plain()
        self._cache: Optional[Tuple[np.ndarray, List[str]]] = None

    @property
    def encrypted(self) -> bool:
        return self.cipher is not None

    def _pack(self, raw: bytes) -> Tuple[bytes, int]:
        return (self.cipher[0](raw), 1) if self.cipher else (raw, 0)

    def _unpack(self, blob: bytes, enc: int) -> bytes:
        if not enc:
            return blob
        if not self.cipher:
            raise RuntimeError("模板已加密，但当前拿不到机器密钥，无法解密")
        return self.cipher[1](blob)

    def _migrate_plain(self):
        if not self.cipher:
            return
        rows = self._db.execute("SELECT id, embedding FROM templates WHERE enc=0").fetchall()
        for rid, b in rows:
            self._db.execute("UPDATE templates SET embedding=?, enc=1 WHERE id=?", (self.cipher[0](b), rid))
        if rows:
            self._db.commit()
            self._db.execute("VACUUM")  # 清掉空闲页里的明文残留

    def add(self, person_id: str, embedding: np.ndarray, name: str = "",
            quality: Optional[dict] = None, source: str = "") -> int:
        e = np.asarray(embedding, np.float32).ravel()
        e = e / (np.linalg.norm(e) or 1.0)
        blob, enc = self._pack(e.tobytes())
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO templates(person_id,name,embedding,dim,quality,source,created_at,enc)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (person_id, name, blob, e.size, json.dumps(quality or {}), source, time.time(), enc))
            self._db.commit()
            self._cache = None
            return int(cur.lastrowid)

    def remove_person(self, person_id: str) -> int:
        with self._lock:
            n = self._db.execute("DELETE FROM templates WHERE person_id=?", (person_id,)).rowcount
            self._db.commit()
            if n:
                self._db.execute("VACUUM")  # 彻底清除：不在空闲页残留
            self._cache = None
            return n

    def invalidate(self):
        self._cache = None

    def count(self) -> Dict[str, int]:
        rows = self._db.execute("SELECT person_id, COUNT(*) FROM templates GROUP BY person_id")
        return {p: c for p, c in rows}

    def list(self) -> List[dict]:
        rows = self._db.execute("SELECT id, person_id, name, quality, source, created_at FROM templates")
        return [dict(id=r[0], person_id=r[1], name=r[2], quality=json.loads(r[3] or "{}"),
                     source=r[4], created_at=r[5]) for r in rows]

    def matrix(self) -> Tuple[np.ndarray, List[str]]:
        if self._cache is None:
            rows = self._db.execute("SELECT person_id, embedding, enc FROM templates").fetchall()
            if rows:
                M = np.stack([np.frombuffer(self._unpack(b, enc), np.float32) for _, b, enc in rows])
            else:
                M = np.zeros((0, 512), np.float32)
            self._cache = (M, [r[0] for r in rows])
        return self._cache

    @staticmethod
    def match(queries: np.ndarray, M: np.ndarray, ids: List[str], threshold: float
              ) -> List[Tuple[Optional[str], float]]:
        """每个 query 返回 (best_person|None, best_sim)，同一人的多个模板取最大值。"""
        if len(queries) == 0:
            return []
        if M.shape[0] == 0:
            return [(None, 0.0)] * len(queries)
        S = np.asarray(queries, np.float32) @ M.T
        out = []
        for row in S:
            j = int(np.argmax(row))
            sim = float(row[j])
            out.append((ids[j] if sim >= threshold else None, sim))
        return out

    def close(self):
        self._db.close()
