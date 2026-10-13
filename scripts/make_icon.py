"""生成应用图标。真源在 `apps/desktop/assets/icons/icon.png`（1024×1024），其余尺寸由它派生。

设计：红底圆角方块 + 白色「识」字。纯平面，无渐变，任意尺寸下都清晰。

Python 侧零依赖之外的东西，只需要 Pillow：

    .venv/bin/python scripts/make_icon.py

改颜色 / 改字只改本文件的常量，重跑即可。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "desktop" / "assets" / "icons"

# macOS 图标规范：圆角半径约为边长的 22.37%
BG = (202, 32, 32)  # 红
FG = (255, 255, 255)  # 白
GLYPH = "识"
CORNER_RATIO = 0.2237
GLYPH_RATIO = 0.64  # 字高占图标边长

FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]
SIZES = [1024, 512, 256, 128, 64, 32, 22, 16]


def _font(px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, px)
    raise SystemExit("找不到可用的中文字体，请在 FONT_CANDIDATES 里补一个路径")


def render(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * CORNER_RATIO), fill=BG)

    font = _font(int(size * GLYPH_RATIO))
    # 用字形实际包围盒居中，避免不同字体的基线 / 边距差异造成视觉偏心
    l, t, r, b = d.textbbox((0, 0), GLYPH, font=font)
    d.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), GLYPH, font=font, fill=FG)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = render(1024)
    for s in SIZES:
        im = master if s == 1024 else master.resize((s, s), Image.LANCZOS)
        im.save(OUT / ("icon.png" if s == 1024 else f"icon{s}.png"))
    print(f"已生成 {len(SIZES)} 个尺寸 → {OUT}")


if __name__ == "__main__":
    main()
