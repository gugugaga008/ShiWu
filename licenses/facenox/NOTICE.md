# Facenox

`src/shiwu/` 中相当一部分代码来自 **Facenox** 项目。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/facenox/facenox |
| 锁定 commit | `10a4b64f05403aed3e7c864ae71cd574546da9f6` |
| 许可 | GNU AGPL-3.0（见同目录 `LICENSE`，© 2025-2026 Facenox） |
| 第三方组件 | 见同目录 `THIRD_PARTY_LICENSES.md` |

## 合入范围

从上游 `server/` 目录取入以下模块（代码基本原样，仅补齐包名前缀、合并入口、统一路径出口）：

| 合入到 | 来源 |
| --- | --- |
| `src/shiwu/api/routes/`、`api/deps.py`、`api/schemas.py` | 考勤 HTTP 接口 |
| `src/shiwu/core/` | 人脸检测 / 识别 / 活体 / 追踪 ONNX 封装 |
| `src/shiwu/database/`、`migrations/`、`alembic.ini` | SQLAlchemy 模型、仓储、Alembic 迁移 |
| `src/shiwu/services/` | 考勤判定、检测管道、时间权威 |
| `src/shiwu/config/`、`middleware/`、`utils/` | 配置、CORS、通用工具 |
| `src/shiwu/assets/models/*.onnx` | `detector` / `liveness` / `recognizer` 三个模型 |
| `src/shiwu/hooks/` | PyInstaller 运行钩子 |
| `src/shiwu/app.py` 中的 `/attendance/*`、`/face/*` 路由与 lifespan | 上游 `main.py` |

**未取入**：上游的 Electron 桌面端、测试套件、构建脚本（PyInstaller spec / hook / build_*.sh|bat）、`pytest.ini`、`package.json`、文档。

## 许可后果

AGPL-3.0 是传染性许可：本产品整体因此以 AGPL-3.0 发布（见仓库根 `LICENSE`）。
向网络用户提供服务时，必须按 AGPL-3.0 第 13 条提供对应源码。
