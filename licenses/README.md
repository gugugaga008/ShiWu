# 第三方许可与归属

这个目录放的是**许可与归属文件**，不是业务代码。业务代码里不出现上游项目的名字，归属信息集中在这里。

## 为什么需要这个目录

`识务` 的代码有三个来源，其中两个是第三方项目。AGPL-3.0 与 MIT 都要求保留原作者的版权声明与许可全文。
把原始文件搬进这里，是为了在清理命名（去掉上游项目名）的同时**不丢失法律要求的署名**。

## 索引

| 路径 | 内容 |
| --- | --- |
| `../LICENSE` | 本项目自身的许可：AGPL-3.0 全文，含上游版权行 |
| `../NOTICE` | 项目声明 + 全部第三方归属清单（总入口） |
| `facenox/LICENSE` | 上游 Facenox 的 AGPL-3.0 原文（© 2025-2026 Facenox） |
| `facenox/NOTICE.md` | 合入了哪些模块、哪个 commit、删了什么、许可后果 |
| `facenox/THIRD_PARTY_LICENSES.md` | Facenox 自身依赖的第三方许可（Electron / React / ONNX Runtime / OpenCV / 模型组件等） |
| `shadcn-admin/LICENSE` | 上游 shadcn-admin 的 MIT 原文（© 2024 Sat Naing） |
| `shadcn-admin/NOTICE.md` | `apps/web/` 基于它做了哪些改动 |
| `desktop-NOTICE.md` | 桌面端外壳的第三方归属（Electron、图标与音效素材） |

## 两个刻意的例外

代码里保留了两处上游字面量，因为它们是**数据格式标识**而不是项目名，改动会让已有数据读不回来：

| 位置 | 值 | 原因 |
| --- | --- | --- |
| `src/shiwu/core/cipher.py` | `BLOB_MAGIC = b"FACENOX\x00\x01"` | 加密备份文件的文件头，等同 zip 的 `PK`；改了旧备份无法解密 |
| `src/shiwu/core/cipher.py` | keyring `service = "facenox-biometric-key"` | 机器密钥在系统钥匙串里的条目名；改了就取不回已加密的数据 |

## 素材

`assets/videos/` 的测试视频来自 Pexels（Pexels License，允许免费使用与修改，不要求署名）。
不随仓库分发，用 `scripts/fetch_assets.sh` 拉取。
