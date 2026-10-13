"""识务所有路径的唯一出口。改目录结构只改这里。

分三类，不要混：

1. **只读资源**（随程序分发，永不写入）
   `resource_dir()` / `models_dir()` / `migrations_dir()` / `alembic_config_path()`
   开发时 = `src/shiwu/`；打包后 = `sys._MEIPASS`。

2. **产品数据**（识务自己的东西）—— `data_dir()` → `var/data`
   事件日志 `events.db`、规则 `rules.json`、设置 `settings.json`、多模板库 `templates.db`、快照 `snapshots/`

3. **人脸库与考勤库** —— `gallery_data_dir()`（旧名 `DATA_DIR`）→ `var/gallery`
   考勤库 `attendance.db`、人脸特征库 `face_database.db`、机器密钥、服务日志

前两类目录必须可写。打包运行时**绝不能**在安装目录里建库，所以冻结后
data_dir / gallery_data_dir 落到系统用户目录，并被 `SHIWU_DATA_DIR` / `SHIWU_GALLERY_DIR` 覆盖。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from .envutil import getenv

# ---------------------------------------------------------------- 运行形态
IS_FROZEN = bool(getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"))

PKG_DIR = Path(__file__).resolve().parent
"""包目录：src/shiwu（开发）或 _MEIPASS（打包）"""

_BUNDLE_DIR = Path(sys._MEIPASS) if IS_FROZEN else PKG_DIR
"""只读资源根目录"""

ROOT = PKG_DIR.parents[1] if not IS_FROZEN else _BUNDLE_DIR
"""仓库根目录。打包后等于只读资源根目录，不要往这里写东西。"""


def resource_dir() -> Path:
    return _BUNDLE_DIR


def models_dir() -> Path:
    return _BUNDLE_DIR / "assets" / "models"


def migrations_dir() -> Path:
    return _BUNDLE_DIR / "migrations"


def alembic_config_path() -> Path:
    return _BUNDLE_DIR / "alembic.ini"


def ui_dist_dir() -> Path:
    """管理界面构建产物。打包后是 bundle 里的 ui/，开发时是 apps/web/dist。"""
    if IS_FROZEN:
        return _BUNDLE_DIR / "ui"
    return ROOT / "apps" / "web" / "dist"


# ---------------------------------------------------------------- 可写目录
def _user_data_home() -> Path:
    if sys.platform == "win32":
        base = os.getenv("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.getenv("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base)


def data_dir() -> Path:
    """识务自己的数据（规则、事件日志、多模板库、快照）。"""
    default = _user_data_home() / "ShiWu" / "data" if IS_FROZEN else ROOT / "var" / "data"
    d = Path(getenv("SHIWU_DATA_DIR") or default)
    d.mkdir(parents=True, exist_ok=True)
    return d


def gallery_data_dir() -> Path:
    """人脸库与考勤库所在目录（FaceRecognizer / 成员表 / 迁移）。"""
    default = _user_data_home() / "ShiWu" / "gallery" if IS_FROZEN else ROOT / "var" / "gallery"
    d = Path(getenv("SHIWU_GALLERY_DIR") or default)
    d.mkdir(parents=True, exist_ok=True)
    return d


def videos_dir() -> Path:
    """测试素材视频。"""
    return ROOT / "assets" / "videos"


def out_dir() -> Path:
    """脚本与评测的产物目录。"""
    d = ROOT / "var" / "out"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------- 兼容常量
# 历史代码在导入期直接使用这些常量，保留同名以便一次性迁移完成。
BASE_DIR = _BUNDLE_DIR
PROJECT_ROOT = ROOT
MODELS_DIR = models_dir()
MIGRATIONS_DIR = migrations_dir()
ALEMBIC_CONFIG_PATH = alembic_config_path()
DATA_DIR = gallery_data_dir()
