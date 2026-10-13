# assets

测试与演示素材。**不随仓库分发**（见根目录 `.gitignore`），用脚本拉取：

```bash
bash scripts/fetch_assets.sh
```

| 目录 | 内容 | 来源 |
| --- | --- | --- |
| `videos/` | 识别管道、跨视频评测与演示用的短片（1280 宽、25fps、20s 以内） | Pexels，Pexels License（可免费使用与修改，不要求署名） |
| `preview/` `raw/` | 脚本中间产物 | 本地生成 |

`videos/` 里两类素材：

- `pexels_6760xxx / 9652xxx / 5051518 / 6145693`：回归与评测用的原始素材（`tests/`、`scripts/cross_video_eval.py`）
- `pexels_7845250 / 8136078 / 7844921 / 8519360`：正面近景人像，供 `scripts/seed_demo.py` 与 README 截图使用

这些片子里的**人是演员**，与真实人员无关；人脸库和事件数据都只存在本机 `var/`。
