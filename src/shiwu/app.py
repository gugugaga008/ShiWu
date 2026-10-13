"""识务的 FastAPI 应用组装：一个 app，三条前缀。

    /attendance/*  /face/*  /detect  /ws/*  成员、人脸库、识别
    /boss/*                                识别管道、规则、事件、采集、设置
    /ui/*                                  管理界面（构建产物）

本地 token 校验走中间件；`/`（健康检查）与 CORS 预检不校验。
"""
from __future__ import annotations

import hmac
import logging
import os
import secrets
from pathlib import Path
from urllib.parse import parse_qs

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.responses import HTMLResponse, RedirectResponse
from starlette.staticfiles import StaticFiles

from . import paths
from .api.endpoints import router as face_router
from .api.boss.routes import router as boss_router
from .config.logging_config import get_logging_config
from .config.models import (
    FACE_DETECTOR_CONFIG,
    FACE_RECOGNIZER_CONFIG,
    FACE_TRACKER_CONFIG,
    LIVENESS_DETECTOR_CONFIG,
)
from .core.lifespan import lifespan
from .middleware.cors import setup_cors

logger = logging.getLogger(__name__)

# 没有注入 token 时（例如直接 `python -m shiwu`）生成一次性 nonce，
# 保证本机接口不会完全敞着；nonce 在启动时打印。
_STARTUP_NONCE: str = secrets.token_urlsafe(32)


def effective_token() -> str:
    return os.getenv("SHIWU_API_TOKEN") or _STARTUP_NONCE


def is_valid_local_token(provided: str) -> bool:
    return hmac.compare_digest(provided, effective_token())


def create_app() -> FastAPI:
    app = FastAPI(
        title="识务",
        description="本地人脸识别预警服务：成员管理、识别管道、规则动作。",
        lifespan=lifespan,
    )
    setup_cors(app)

    @app.middleware("http")
    async def verify_local_token(request: Request, call_next):
        """只接受携带本机会话 token 的请求。"""
        if request.url.path == "/" or request.method == "OPTIONS":
            return await call_next(request)

        if not getattr(app.state, "_token_warn_emitted", False):
            if not os.getenv("SHIWU_API_TOKEN"):
                logger.warning(
                    "SHIWU_API_TOKEN 未设置，已生成启动 nonce。开发时用 "
                    "X-Shiwu-Token: %s 访问。", _STARTUP_NONCE)
            app.state._token_warn_emitted = True

        if not is_valid_local_token(request.headers.get("X-Shiwu-Token", "")):
            return JSONResponse(status_code=401, content={"error": "Unauthorized"})
        return await call_next(request)

    app.include_router(face_router)
    app.include_router(boss_router)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        logger.error("未处理的异常：%s", exc, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Internal Server Error",
                     "detail": str(exc) if os.getenv("ENVIRONMENT") == "development" else None},
        )

    @app.get("/")
    async def health():
        return {"message": "识务服务运行中", "status": "healthy"}

    @app.get("/models")
    async def models_info():
        from .core.lifespan import face_detector, face_recognizer, liveness_detector

        info: dict = {}

        if face_detector and getattr(face_detector, "detector", None) is not None:
            info["face_detector"] = {"available": True, "info": {
                "model_path": str(FACE_DETECTOR_CONFIG["model_path"]),
                "input_size": list(FACE_DETECTOR_CONFIG["input_size"]),
                "conf_threshold": getattr(face_detector, "score_threshold", FACE_DETECTOR_CONFIG["score_threshold"]),
                "nms_threshold": getattr(face_detector, "nms_threshold", FACE_DETECTOR_CONFIG["nms_threshold"]),
                "top_k": FACE_DETECTOR_CONFIG["top_k"],
                "min_face_size": getattr(face_detector, "min_face_size", FACE_DETECTOR_CONFIG["min_face_size"]),
                "edge_margin": FACE_DETECTOR_CONFIG["edge_margin"],
            }}
        else:
            info["face_detector"] = {"available": False}

        if liveness_detector and getattr(liveness_detector, "ort_session", None) is not None:
            info["liveness_detector"] = {"available": True, "info": {
                "model_path": str(LIVENESS_DETECTOR_CONFIG["model_path"]),
                "pass_margin": getattr(liveness_detector, "pass_margin", LIVENESS_DETECTOR_CONFIG["pass_margin"]),
                "spoof_margin": getattr(liveness_detector, "spoof_margin", LIVENESS_DETECTOR_CONFIG["spoof_margin"]),
                "required_real_frames": LIVENESS_DETECTOR_CONFIG.get("required_real_frames", 3),
            }}
        else:
            info["liveness_detector"] = {"available": False}

        if face_recognizer and getattr(face_recognizer, "session", None) is not None:
            info["face_recognizer"] = {"available": True, "info": {
                "model_path": str(FACE_RECOGNIZER_CONFIG["model_path"]),
                "input_size": list(FACE_RECOGNIZER_CONFIG["input_size"]),
                "similarity_threshold": getattr(face_recognizer, "similarity_threshold",
                                                FACE_RECOGNIZER_CONFIG["similarity_threshold"]),
                "embedding_dimension": FACE_RECOGNIZER_CONFIG["embedding_dimension"],
                "providers": FACE_RECOGNIZER_CONFIG["providers"],
            }}
        else:
            info["face_recognizer"] = {"available": False}

        info["face_tracker"] = {"available": True, "info": {
            "track_thresh": FACE_TRACKER_CONFIG["track_thresh"],
            "match_thresh": FACE_TRACKER_CONFIG["match_thresh"],
            "track_buffer": FACE_TRACKER_CONFIG["track_buffer"],
            "frame_rate": FACE_TRACKER_CONFIG["frame_rate"],
        }}
        return {"models": info}

    return app


class SpaStatic(StaticFiles):
    """管理界面的静态托管：SPA 回退 + token 注入。"""

    async def get_response(self, path, scope):
        root = Path(self.directory)
        if path in ("", ".", "index.html") or not (root / path).exists():
            html = (root / "index.html").read_text("utf-8")
            tok = os.getenv("SHIWU_API_TOKEN", "")
            html = html.replace("<head>", f"<head><script>window.__SHIWU_TOKEN__={tok!r};"
                                          f"window.__SHIWU_BASE__='/ui';</script>", 1)
            return HTMLResponse(html, headers={"Cache-Control": "no-store"})
        return await super().get_response(path, scope)


def build_asgi():
    """返回最终 ASGI 应用：app + /ui 静态前端。

    页面里的 <img src> 没法带自定义请求头，所以 /boss/* 允许用 ?token= 传，
    这里在进入应用前把它转成请求头。
    """
    app = create_app()
    static = SpaStatic(directory=str(paths.ui_dist_dir()), check_dir=False)

    async def dispatcher(scope, receive, send):
        if scope["type"] == "http":
            url_path = scope["path"]
            if url_path == "/ui":
                return await RedirectResponse("/ui/")(scope, receive, send)
            if url_path.startswith("/ui/"):
                scope = dict(scope, path=url_path[3:], root_path="/ui")
                return await static(scope, receive, send)
            if url_path.startswith("/boss/") and scope.get("query_string"):
                q = parse_qs(scope["query_string"].decode())
                if "token" in q:
                    headers = [h for h in scope["headers"] if h[0] != b"x-shiwu-token"]
                    headers.append((b"x-shiwu-token", q["token"][0].encode()))
                    scope = dict(scope, headers=headers)
        return await app(scope, receive, send)

    return dispatcher


def serve(host: str = "127.0.0.1", port: int | None = None) -> None:
    port = port or int(os.getenv("SERVER_PORT", "7400"))
    os.environ["SERVER_PORT"] = str(port)

    logging.config.dictConfig(get_logging_config())

    from .database.migrate import run_migrations

    run_migrations()

    from .api.boss.runtime import runtime  # 导入即建库、建规则引擎、起 tick 线程

    runtime.port = port
    runtime.token = os.getenv("SHIWU_API_TOKEN", "")
    if not runtime.token:
        raise SystemExit("请设置 SHIWU_API_TOKEN（与前端/Electron 共享）")

    uvicorn.run(build_asgi(), host=host, port=port, log_level="info")
