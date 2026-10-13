"""环境变量取值：统一 SHIWU_* 前缀。

集中在这里是为了让「有哪些可调项」一眼可见，也方便测试里 monkeypatch。
"""
from __future__ import annotations

import os
from typing import Optional


def getenv(*names: str, default: Optional[str] = None) -> Optional[str]:
    """按顺序返回第一个非空的环境变量值。"""
    for n in names:
        v = os.getenv(n)
        if v is not None and v != "":
            return v
    return default
