"""服务入口：`shiwu` 或 `python -m shiwu`。"""
from __future__ import annotations

import argparse
import multiprocessing
import os


def main() -> None:
    multiprocessing.freeze_support()  # PyInstaller 独立可执行文件需要
    ap = argparse.ArgumentParser(prog="shiwu", description="识务本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.getenv("SERVER_PORT", "7400")))
    args = ap.parse_args()

    from .app import serve

    serve(args.host, args.port)


if __name__ == "__main__":
    main()
