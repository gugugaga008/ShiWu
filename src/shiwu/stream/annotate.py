"""在帧上画框与标签（截图/调试用）。有 Pillow + CJK 字体时支持中文标签。"""
import glob
import os
import sys

import cv2
import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFont
    _CANDS = (glob.glob(os.path.join(getattr(sys, "_MEIPASS", "/nonexistent"), "fonts", "*.tt*"))
              + sorted(glob.glob("/usr/share/fonts/**/NotoSansCJK-Bold.ttc", recursive=True)
                       + glob.glob("/usr/share/fonts/**/*CJK*.tt*", recursive=True))
              + [p for p in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                             "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Light.ttc"]
                 if os.path.exists(p)])
    _FONT_PATH = _CANDS[0] if _CANDS else None
except ImportError:  # pragma: no cover
    Image = None
    _FONT_PATH = None


def _label(f):
    tid = f"#{f.get('track_id')} "
    if f.get("person_id"):
        base = tid + f"{f.get('name') or f['person_id'][:8]} sim={f['similarity']:.2f}"
        if f.get("identity_source") == "track":   # 本帧单独没认出，由轨迹投票补上
            base += f" [轨迹投票|帧{f.get('frame_similarity', 0):.2f}]"
        return base
    return tid + f"unknown sim={f.get('similarity', 0):.2f}"


def draw_faces(image, faces, title: str = ""):
    img = image.copy()
    boxes = []
    for f in faces:
        b = f["bbox"]
        x, y, w, h = int(b["x"]), int(b["y"]), int(b["width"]), int(b["height"])
        color = ((0, 200, 0) if f.get("identity_source") != "track" else (200, 140, 0)) \
            if f.get("person_id") else (0, 0, 230)
        cv2.rectangle(img, (x, y), (x + w, y + h), color, 3)
        boxes.append((x, y, h, color, _label(f)))
    if Image is not None and _FONT_PATH:
        pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        d = ImageDraw.Draw(pil)
        font = ImageFont.truetype(_FONT_PATH, 20)
        for x, y, h, color, text in boxes:
            l, t, r, btm = d.textbbox((0, 0), text, font=font)
            th = btm - t + 10
            ty, by = max(0, y - th), y
            nx = max(0, min(x, pil.width - (r - l) - 10))
            if nx != x:  # 右侧放不下：左移并画到框下方，避免压住相邻标签
                ty, by = y + h, y + h + th
            d.rectangle([nx, ty, nx + r - l + 8, by], fill=color[::-1])
            d.text((nx + 4, ty + 2), text, font=font, fill=(255, 255, 255))
        if title:
            d.text((10, 8), title, font=font, fill=(255, 255, 0))
        return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    for x, y, h, color, text in boxes:
        cv2.putText(img, text, (x + 3, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    if title:
        cv2.putText(img, title, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    return img
