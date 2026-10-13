"""统一视频流管道。

    FrameSource (插件)  ->  StreamPipeline  ->  FaceEngine (本地 ONNX)  ->  EventBus  ->  sinks
"""
from .base import Frame, FrameSource, SourceInfo, SourceState
from .registry import register_source, create_source, available_sources, get_source_class
from .events import (
    StreamEvent, EventBus, CallbackSink, QueueSink, JsonlSink, WebSocketSink,
)
from .pipeline import StreamPipeline, PipelineConfig
from . import sources  # noqa: F401  触发内置插件注册

__all__ = [
    "Frame", "FrameSource", "SourceInfo", "SourceState",
    "register_source", "create_source", "available_sources", "get_source_class",
    "StreamEvent", "EventBus", "CallbackSink", "QueueSink", "JsonlSink", "WebSocketSink",
    "StreamPipeline", "PipelineConfig",
]
