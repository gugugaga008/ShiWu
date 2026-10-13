"""视频源插件注册表。新插件用 @register_source("name") 装饰即可，或通过
entry point 组 "shiwu.frame_sources" 由外部包注册。"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Type

from .base import FrameSource

logger = logging.getLogger(__name__)
_REGISTRY: Dict[str, Type[FrameSource]] = {}
_entry_points_loaded = False


def register_source(name: str):
    def deco(cls: Type[FrameSource]) -> Type[FrameSource]:
        if not issubclass(cls, FrameSource):
            raise TypeError(f"{cls} must subclass FrameSource")
        if name in _REGISTRY and _REGISTRY[name] is not cls:
            logger.warning("FrameSource '%s' re-registered by %s", name, cls)
        cls.kind = name
        _REGISTRY[name] = cls
        return cls
    return deco


def _load_entry_points() -> None:
    global _entry_points_loaded
    if _entry_points_loaded:
        return
    _entry_points_loaded = True
    try:
        from importlib.metadata import entry_points
        for ep in entry_points(group="shiwu.frame_sources"):
            try:
                ep.load()
            except Exception as e:  # noqa: BLE001
                logger.warning("load plugin %s failed: %s", ep.name, e)
    except Exception:  # noqa: BLE001
        pass


def get_source_class(name: str) -> Type[FrameSource]:
    _load_entry_points()
    if name not in _REGISTRY:
        raise KeyError(f"unknown FrameSource '{name}', available: {sorted(_REGISTRY)}")
    return _REGISTRY[name]


def create_source(name: str, uri: str, **options: Any) -> FrameSource:
    return get_source_class(name)(uri, **options)


def available_sources() -> List[str]:
    _load_entry_points()
    return sorted(_REGISTRY)
