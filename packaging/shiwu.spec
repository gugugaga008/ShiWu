# -*- mode: python ; coding: utf-8 -*-
"""识务 Python 服务 → 独立可执行文件（onedir）。

    cd <repo> && .venv/bin/pyinstaller packaging/shiwu.spec --noconfirm \
        --distpath dist --workpath build/pyi

产物：`dist/server/shiwu[.exe]`，内含 Python 服务、ONNX 模型、Alembic 迁移与前端 `apps/web/dist`。
`apps/desktop/package.json` 的 extraResources 把它塞进 `resources/server/`。
"""
import os
import platform
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
PKG = ROOT / "src" / "shiwu"          # 包目录：只读资源都在这里
UI = ROOT / "apps" / "web" / "dist"
assert (UI / "index.html").exists(), "先构建前端：cd apps/web && pnpm build"

hidden = (
    collect_submodules("uvicorn")
    + collect_submodules("shiwu")
    + collect_submodules("sklearn.cluster")
    + [
        "shiwu.__main__", "shiwu.app",
        "shiwu.paths",
        "onnxruntime", "onnxruntime.capi",
        "onnxruntime.capi.onnxruntime_pybind11_state",
        "cv2", "numpy", "aiosqlite", "lap",
        "sqlalchemy.dialects.sqlite.aiosqlite",
        "keyring.backends", "websockets", "PIL.ImageFont",
    ]
)
if platform.system() == "Windows":
    hidden += collect_submodules("win32ctypes")

datas = collect_data_files("onnxruntime") + [
    (str(PKG / "assets" / "models"), "assets/models"),   # paths.models_dir()
    (str(PKG / "alembic.ini"), "."),                     # paths.alembic_config_path()
    (str(PKG / "migrations"), "migrations"),             # paths.migrations_dir()
    (str(UI), "ui"),                                     # paths.ui_dist_dir()
]
# 标注用中文字体（本机有 Noto CJK 才打包，其它平台回退系统字体）
for f in ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]:
    if os.path.exists(f):
        datas.append((f, "fonts"))

a = Analysis(
    [str(Path(SPECPATH) / "entry.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[str(ROOT / "src" / "shiwu" / "hooks")],
    excludes=["matplotlib", "tkinter", "PyQt5", "PySide2", "IPython", "notebook",
              "jupyter", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="shiwu", console=True,
          strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="server")
