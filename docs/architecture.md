# 识务（ShiWu）— 架构与实测

本机人脸识别预警产品。人脸识别、特征与事件记录留在本机；主动启用手机预览时，实时画面通过临时局域网只读服务传给手机。

> 快速上手看 `README.md`；本文记录架构决策、接口清单与实测数据。

## 一、分层

```
┌─ apps/desktop/  Electron 外壳 ───────────────────────────┐
│  托盘、托管 Python 子进程、给窗口注入会话 token            │
│  执行规则动作：通知 / 遮挡 / 最小化 / 切程序 / 静音 / 锁屏  │
│  摄像头采集窗口（默认完全隐形，getUserMedia→canvas→JPEG→WS）│
└──────────────────────┬───────────────────────────────────┘
                       │ 127.0.0.1:7400（X-Shiwu-Token）
┌──────────────────────▼───────────────────────────────────┐
│  src/shiwu/  一个 FastAPI app，三组路由挂在一起            │
│    /attendance/*  /face/*   考勤与人脸库                   │
│    /boss/*                  视频源、采集、人员、规则、事件   │
│    /ui/*                    同源托管 apps/web/dist         │
│  ─────────────────────────────────────────────────────    │
│  stream/   FrameSource → StreamPipeline → FaceEngine       │
│  core/     ONNX：检测 / 识别 / 活体 / ByteTrack 追踪        │
│  rules/    规则引擎 + 事件日志（SQLite）                    │
│  enroll/   质量门槛、多照片库、注册流程                      │
│  notify/   快照（AES-GCM 加密）、邮件                        │
│  database/ SQLAlchemy + Alembic                            │
└──────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  apps/web/  React + Vite 管理界面（概览 / 视频源 / 一键采集 / │
│        人员管理 / 规则设置 / 时间线 / 统计 / 设置）           │
└──────────────────────────────────────────────────────────┘
```

## 二、技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 后端 | FastAPI + Uvicorn | 单进程，默认 `127.0.0.1:7400`；`SERVER_PORT` 可覆盖 |
| 人脸 | ONNX Runtime | 检测 1280×720 输入、识别 512 维特征、活体、ByteTrack |
| 聚类 | scikit-learn DBSCAN | cosine, eps 0.42，用于「一键采集」的同一人分簇 |
| 数据 | SQLite | 考勤库 `attendance.db` + 人脸特征库 `face_database.db` |
| 前端 | React + Vite + shadcn/ui | 见 `licenses/shadcn-admin/` |
| 桌面 | Electron | 托盘常驻；打包走 electron-builder |
| Python | ≥ 3.11（开发用 3.13） | `pyproject.toml` 定义依赖 |

### 手机预览边界

管理服务继续只监听回环地址。用户点击「手机预览」才启动独立临时局域网 HTTP 服务，实际只绑定所选本机私网 IPv4，不监听全部网卡；不同网卡使用独立临时端口，会话凭据不能跨网卡使用。手机页面轮询管道已有 JPEG，不另开摄像头、不转发管理 API、人员库或事件接口。电脑端实时预览替换为状态与二维码，Electron 采集视频透明显示；人脸采集缩略图与历史快照不受影响。

每个预览会话使用独立随机访问凭据，只绑定当前一路运行实例，最长 10 分钟。二维码凭据置于 URL fragment，手机脚本通过 `Authorization: Bearer` 请求画面，避免凭据进入服务请求地址和日志；响应禁止缓存，页面不加载外部资源。关闭弹窗、视频源停止或替换、到期均撤销访问；无有效会话后关闭临时监听。局域网 HTTP 无 TLS，二维码持有者可在有效期查看该路画面，因此仅限可信网络，不做公网暴露或云中转。

## 三、路径约定

所有路径只从 `src/shiwu/paths.py` 取，改目录结构只改这一个文件。

| 类别 | 开发时 | 打包后 | 内容 |
|------|--------|--------|------|
| 只读资源 | `src/shiwu/` | `sys._MEIPASS` | ONNX 模型、Alembic 迁移、`alembic.ini` |
| 产品数据 | `var/data` | 用户数据目录 | `events.db`、`rules.json`、`settings.json`、`templates.db`、`snapshots/` |
| 人脸/考勤库 | `var/gallery` | 用户数据目录 | `attendance.db`、`face_database.db`、机器密钥、服务日志 |

覆盖变量：`SHIWU_DATA_DIR`、`SHIWU_GALLERY_DIR`。

## 四、接口

鉴权：除 `GET /` 与 CORS preflight 外，所有请求需带 `X-Shiwu-Token: <token>`。
`?token=` 查询参数会被转换成同名请求头（给 `<img>` / WebSocket 用）。

### 系统

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/` | 健康检查，无需 Token |
| GET | `/models` | 检测 / 活体 / 识别 / 追踪模型状态 |

### 产品接口（`/boss`）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/boss/status` `/boss/monitor` | 服务与管道状态 |
| GET/POST | `/boss/sources/videos` `/boss/sources/cameras` | 可用视频源 / 摄像头 |
| POST | `/boss/pipeline/start` `/stop` `/restart` `/start-defaults` | 管道控制 |
| GET/PUT | `/boss/settings` | 设置（默认源、自适应帧率、邮件…） |
| POST | `/boss/captures` · GET `/boss/captures/{sid}` | 一键采集会话 |
| GET/POST | `/boss/captures/{sid}/clusters` | 聚类结果与编辑 |
| POST | `/boss/captures/{sid}/clusters/{cid}/confirm` | 确认入库 |
| GET/POST | `/boss/people` · PUT/DELETE `/boss/people/{pid}` | 人员增删改查 |
| POST | `/boss/people/{pid}/photos` | 补录多张照片 |
| GET/PUT | `/boss/rules` | 规则 |
| GET | `/boss/eventlog` | 事件日志（识别 / 动作 / 监控开关） |
| GET | `/boss/stats` | 统计 |
| GET | `/boss/snapshots/{...}` | 触发快照（需机器密钥解密） |
| POST | `/boss/actions/result` | 桌面端回报动作执行结果 |
| GET | `/boss/roles` | 角色枚举 |
| POST | `/boss/mobile-preview` | 创建单路手机预览会话（source、可选本机 address）；返回二维码、到期时间与本机网卡地址 |
| DELETE | `/boss/mobile-preview/{id}` | 撤销手机预览会话（仍需管理会话 Token） |
| WS | `/boss/ws` | 事件推送（识别 / 动作 / 设置变更） |
| WS | `/boss/camera/push` | 摄像头采集窗口推帧 |

### 考勤与人脸（`/attendance`、`/face`、`/backup`、`/detect`）

| 分组 | 路径前缀 |
|------|----------|
| 成员 | `/attendance/members`（含 bulk、bulk-delete、按组查询） |
| 分组 | `/attendance/groups`（含 assign-org-id、persons、enroll-face、face-data、bulk-detect/enroll-faces、stats） |
| 记录 | `/attendance/records`（含 void）、`/attendance/sessions`、`/attendance/events` |
| 设置 | `/attendance/settings`（含 time-health、audit-log） |
| 统计与维护 | `/attendance/stats`、`/export`、`/export-embeddings`、`/import-embedding`、`/import-embeddings-batch`、`/import-metadata`、`/cleanup`、`/wipe`、`/unpair`、`/purge-history` |
| 人脸 | `/face/recognize`、`/face/persons`、`/face/person`、`/face/threshold`、`/face/cache/invalidate`、`/face/database`、`/face/stats` |
| 检测 | `POST /detect`（multipart，字段 `image`） |
| 备份 | `POST /backup/export`、`/backup/import`、`/backup/import-encrypted` |
| WebSocket | `/ws/detect/{client_id}`、`/ws/notifications/{client_id}` |

完整 OpenAPI：`GET /openapi.json`。

## 五、实测数据

### 视频源管道（同视频注册后播放）

| 用例 | 视频 | 处理帧 | 命中帧率 | 相似度 min/mean/max | 误识 | 未知脸最高 sim | 平均耗时 |
|------|------|--------|----------|---------------------|------|----------------|----------|
| A | 4 人室内 | 83 @5fps | 96.4% | 0.564 / 0.789 / 0.990 | 0 | 0.30 | 50 ms/帧 |
| B | 2 人室内 | 90 @5fps | 98.9% | 0.563 / 0.816 / 0.986 | 0 | 0.33 | 37 ms/帧 |

识别阈值 0.45；管道内 `min_face_size` 调为 40。
产物：`var/out/<video_id>/{enroll_frame.jpg, hit_*.jpg, events.jsonl, summary.json}`。

### 跨视频（注册视频 → 另一段视频）

评测脚本：`scripts/cross_video_eval.py`（ground truth 在 `tests/fixtures/eval/gt_tracks.json`）。

- 厨房 → 阳台（户外、戴帽）100%，相似度均值 0.663
- 树下 → 特写 100%（0.728）；→ 桥上远景 49%（0.596）
- 侧脸 19%（0.474）
- 小脸（40–89px）识别率 85–100%（同视频近景注册）
- **误识 0 次**；陌生人相似度最高 0.449

### 轨迹投票 + 多照片注册

轨迹投票实现：`src/shiwu/stream/voting.py`（TrackVoter）、`src/shiwu/enroll/{quality,gallery,service}.py`。

- 新增 `stream/voting.py`（TrackVoter）与 `enroll/{quality,gallery,service}.py`
- 新事件 `track_identity`；每张脸新增 `frame_person_id / frame_similarity / identity_source / track_votes`
- 侧脸 19.4% → **97.2%**，远景 46.7% → **95.6%**，误识 0

### 摄像头（本机实测，macOS 26 / M1 Max）

- 权限打通后 Electron 采集 → WebSocket 推流 → Python 管道全链路正常
- 管道统计：`frames_read: 156, frames_processed: 75, avg_proc_ms: 21.5`
- 采到的坑见 `README.md`「摄像头权限」：TCC 责任进程会被启动方继承，导致直接拒绝、不弹窗

## 六、打包

```bash
cd apps/web && pnpm build && cd ../..               # 先出 apps/web/dist
.venv/bin/pyinstaller packaging/shiwu.spec --noconfirm \
  --distpath dist --workpath build/pyi              # → dist/server/
cd apps/desktop && pnpm dist:mac                    # 或 dist:win / dist:linux
```

- `packaging/shiwu.spec`：PyInstaller onedir，内含模型、迁移、`alembic.ini` 与前端
- `apps/desktop/package.json` 的 `extraResources` 把它塞进 `resources/server/`
- macOS entitlements `apps/desktop/build/entitlements.mac.plist` 必须含
  `com.apple.security.device.camera`，否则 hardened runtime 下 TCC 直接拒绝

## 七、已知约束

- **AGPL-3.0**：网络服务需遵守源码提供义务。归属与许可原件在 `NOTICE` 与 `licenses/`。
- **摄像头**：必须在有真实摄像头、且能给应用授权的主机上验收。headless / 无摄像头环境跑不了这条闭环。
- **`pnpm approve-builds`**：首次 `pnpm install` 后可能需批准 esbuild 等构建脚本。
- **机器密钥**：加密快照与备份依赖系统钥匙串里的机器密钥。换机器 / 换用户后旧数据解不开。
- **采集窗口**：默认 `SHIWU_CAMERA_MODE=invisible`（完全看不见）。可切 `visible`/`offscreen`/`hidden`，四种实测都能采到帧。权限与排查见 [`camera.md`](camera.md)。
