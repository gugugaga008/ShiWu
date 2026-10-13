"""PyInstaller 入口脚本。

不能用 `src/shiwu/__main__.py` 当入口：PyInstaller 会把它作为顶层脚本执行，
包上下文丢失，里面的 `from .app import serve` 会报
`attempted relative import with no known parent package`。
这里用绝对导入，`shiwu` 包本身照常被收进 hiddenimports。
"""
import multiprocessing

from shiwu.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
