"""触发快照：带框画面 JPEG，按本机密钥 AES-GCM 加密后存到 <data>/snapshots/YYYYMMDD/，可设保留天数。"""
from __future__ import annotations

import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from ..enroll.gallery import local_cipher
from ..paths import data_dir

_ID = re.compile(r"^\d{8}/[0-9a-f]{12}$")
MAGIC_PLAIN = b"BOSSJPG0"


class SnapshotStore:
    def __init__(self, root: Optional[Path] = None, cipher="auto"):
        self.root = Path(root or data_dir() / "snapshots")
        self.cipher = local_cipher() if cipher == "auto" else cipher
        self._lock = threading.Lock()
        self._last_purge = 0.0

    @property
    def encrypted(self) -> bool:
        return self.cipher is not None

    def _path(self, sid: str) -> Path:
        if not _ID.match(sid or ""):
            raise KeyError(sid)
        return self.root / f"{sid}.jpg.enc"

    def save(self, jpeg: bytes, ts: Optional[float] = None) -> str:
        ts = ts or time.time()
        sid = time.strftime("%Y%m%d", time.localtime(ts)) + "/" + uuid.uuid4().hex[:12]
        p = self._path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        blob = self.cipher[0](jpeg) if self.cipher else MAGIC_PLAIN + jpeg
        with self._lock:
            p.write_bytes(blob)
        return sid

    def load(self, sid: str) -> bytes:
        p = self._path(sid)
        if not p.exists():
            raise KeyError(sid)
        blob = p.read_bytes()
        if blob.startswith(MAGIC_PLAIN):
            return blob[len(MAGIC_PLAIN):]
        if not self.cipher:
            raise KeyError("无法解密")
        return self.cipher[1](blob)

    def exists(self, sid: str) -> bool:
        try:
            return self._path(sid).exists()
        except KeyError:
            return False

    def delete(self, sid: str) -> bool:
        try:
            p = self._path(sid)
        except KeyError:
            return False
        if p.exists():
            p.unlink()
            return True
        return False

    def purge(self, keep_days: float, now: Optional[float] = None) -> int:
        """删除早于 keep_days 天的快照目录（keep_days<=0 不清理）。"""
        if keep_days <= 0 or not self.root.exists():
            return 0
        now = now or time.time()
        cutoff = time.strftime("%Y%m%d", time.localtime(now - keep_days * 86400))
        n = 0
        for d in self.root.iterdir():
            if d.is_dir() and re.fullmatch(r"\d{8}", d.name) and d.name < cutoff:
                n += sum(1 for _ in d.glob("*.enc"))
                shutil.rmtree(d, ignore_errors=True)
        self._last_purge = now
        return n

    def purge_all(self) -> int:
        """删除全部快照目录（用户主动清除数据时使用）。"""
        if not self.root.exists():
            return 0
        n = sum(1 for _ in self.root.glob("*/*.enc"))
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)
        return n

    def maybe_purge(self, keep_days: float):
        if time.time() - self._last_purge > 3600:
            self.purge(keep_days)

    def stats(self) -> dict:
        files = list(self.root.glob("*/*.enc")) if self.root.exists() else []
        return {"count": len(files), "bytes": sum(f.stat().st_size for f in files), "encrypted": self.encrypted}
