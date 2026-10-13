#!/usr/bin/env bash
# 下载并转码 Pexels 测试视频到 assets/videos（见 assets/README.md）
# 前 7 段是识别管道/回归测试用的原始素材；后 4 段是演示与截图用的人像素材（中国面孔，均为正面近景）
set -e; cd "$(dirname "$0")/../assets"; mkdir -p videos raw
for id in 6760570 9652476 5051518 6145693 6760590 9652478 9652480 8519360 8136078 7845250 7844921; do
  [ -f videos/pexels_$id.mp4 ] && continue
  curl -fL -A "Mozilla/5.0" -o raw/$id.mp4 "https://www.pexels.com/download/video/$id/"
  ffmpeg -y -loglevel error -i raw/$id.mp4 -vf "scale=1280:-2,fps=25" -t 20 -an -c:v libx264 -crf 23 videos/pexels_$id.mp4
done
rm -rf raw; ls -la videos
