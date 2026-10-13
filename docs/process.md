# 变更记录

按 `AGENTS.md` 的格式约定记录：小改动用 `时间 | 涉及文件 | 修改内容 | 验证结果`，
大改动用 `时间 | 目标 | 涉及文件及主要修改 | 影响范围 | 验证结果 | 遗留事项`。
时间格式 `YY-MM-DD-HHMM`，只追加不改写。

---

## 26-10-13-1410 根目录收敛：web/ desktop/ 归入 apps/

- **目标**：减少根目录杂乱。`web/` → `apps/web/`、`desktop/` → `apps/desktop/`、
  `PROJECT.md` → `docs/architecture.md`、`eval/gt_tracks.json` → `tests/fixtures/eval/gt_tracks.json`。
  不改产品行为，不做无关重构。
- **涉及文件及主要修改**
  - 移动上述 4 处；`eval/` 空目录删除
  - 路径同步 16 个文件：`src/shiwu/paths.py`（`ui_dist_dir`）、`packaging/shiwu.spec`（`UI` 常量与注释）、
    `apps/desktop/src/backend.js`（`REPO` 上溯改 3 级，`.venv` 定位与 `python -m shiwu` 的 cwd）、
    `apps/desktop/package.json`（`extraResources.from` 改 `../../dist/server`）、
    `scripts/{cross_video_eval,make_icon,desktop_e2e,desktop_e2e_leave,appimage_smoke}`、
    `.gitignore`、`.github/workflows/release.yml`（顺带修掉引用不存在的 `server/`、`app/`、
    `vendor/`、`boss_server.spec`）、`README.md`、`docs/architecture.md`、`NOTICE`、
    `licenses/{README.md,shadcn-admin/NOTICE.md,desktop-NOTICE.md}`
- **影响范围**：开发启动、前端构建、PyInstaller/electron-builder 打包、e2e 与截图脚本的全部路径。
  `var/`（用户数据）、`licenses/`、`src/shiwu/assets/models/`、两个 lockfile、
  `apps/desktop/build/entitlements.mac.plist`、既有 `dist/` 与 `build/` 均未改动。
- **验证结果**
  - `.venv/bin/python -m pytest -q tests` → 61 passed, 14 skipped（缺 `assets/videos` 的用例按既有条件跳过）
  - `apps/desktop`：`node --test test/actions.test.js test/windows.test.js` → 11 passed
  - `apps/web`：`pnpm build` → 成功
  - PyInstaller 用新 spec 打包到 `/tmp`（未覆盖仓库 `dist/`）→ exit 0；冻结产物实跑：
    `/models` 三个模型 available，`/ui/` 与首屏 JS 均 200
  - Electron 实启（`SHIWU_USERDATA_DIR=/tmp/...`）：后端 5 秒就绪、命令行为
    `.venv/bin/python -m shiwu --port 7411`；CDP 截图确认总览页完整渲染，点击「视频源」路由到 `/ui/sources` 正常
- **遗留事项**
  - `.venv` 内 console script 的 shebang 指向已不存在的 `vendor/facenox/venv/bin/python`
    （`pytest`/`pyinstaller` 直接调用会报 bad interpreter，用 `python -m` 正常）；未重建 venv
  - `apps/desktop` 的 `"test": "node --test test/"` 在 Node 24 下必失败（`/tmp` 空目录可复现，与迁移无关）
  - 前端「识务 · 本地 127.0.0.1:7400」端口号写死，实际端口非 7400 时不更新
  - 本次未验证真机摄像头闭环与 `pnpm dist:mac` 完整安装包

---

## 26-10-13-1435 README 重写、演示数据与截图工具

- **目标**：README 收敛结构、补真实截图；让演示数据与截图可复现；摄像头长文从 README 拆出。
- **涉及文件及主要修改**
  - `README.md` 重写：简介 + 8 张界面截图 + 装依赖/启动/只用后端/演示数据 + 摄像头（指向 `docs/camera.md`）
    + 目录 + 数据位置 + 测试 + 打包 + 许可
  - 新增 `docs/camera.md`：macOS TCC 责任进程、采集窗口四种模式实测表、零帧诊断与排查
  - 新增 `assets/README.md`：素材来源（Pexels）与用途，修掉 README 与 `fetch_assets.sh` 的悬空引用
  - `docs/architecture.md`：采集窗口条目补 `camera.md` 链接；删掉指向不存在的
    `docs/cross-video-eval.md`、`docs/track-voting-and-enrollment.md` 的引用，改为指向实际脚本/模块
  - `scripts/fetch_assets.sh`：素材 id 列表增加 4 段中国面孔正面近景人像
  - `scripts/seed_demo.py`：改为「(视频, 姓名, 角色) 列表 → 一段视频登记一个人」；不再依赖多人远景视频
  - `scripts/ui_screenshots_v11.mjs`：修 `../app/package.json` 断路径（迁漏项）、支持 `SHIWU_CHROMIUM`
    指定浏览器、默认输出 `docs/images`、页面文件名改成语义名
  - 新增 `docs/images/*.png` 共 10 张：8 个页面 + 时间线快照弹窗 + 遮挡界面，README 引用其中 7 张
- **影响范围**：文档、演示数据与截图脚本；`src/`、`apps/desktop/src/` 等产品运行时代码无改动。
  演示数据全部写入 `/tmp` 下的临时数据目录，仓库 `var/` 未被触碰。
- **验证结果**
  - 素材筛选：逐个抽帧人工查看 + 用项目自身质量门槛打分（单簇达标样本 35/39/48/50，最大脸宽 166–333px），
    远景或侧脸素材（0 达标样本）已剔除
  - `scripts/seed_demo.py` 实跑（`SHIWU_DATA_DIR=/tmp/...`）→ 登记 4 人、6 条规则、7 天 99 条识别 / 37 次触发，
    无异常退出
  - `scripts/ui_screenshots_v11.mjs` 实跑 → 9 张截图，无 pageerror / console error
  - 逐张查看截图确认渲染：概览（4 人 / 15 模板 / 事件日志）、一键采集（4 个候选簇与人脸缩略图）、
    人员管理、规则设置、时间线快照、统计、设置、视频源均正常
  - `README.md` 引用的 7 张截图路径与 4 个文档链接逐一确认存在
- **遗留事项**
  - 摄像头闭环仍未做真机验证（无摄像头授权环境只能人工验）
  - `apps/desktop/src/windows/cover.html` 忽略 `showCover(style)` 传入的 style 参数，只有 Excel 一种外观，
    而规则里可填 `code`；截图只覆盖 Excel
  - `scripts/ui_screenshots.mjs`（5 页版）与 `ui_screenshots_v11.mjs`（8 页版）功能重复，未合并
  - 演示截图中的数据由 `seed_demo.py` 合成，人物为素材视频里的演员

---

26-10-13-1507 | `README.md`、`docs/process.md` | README 改为产品首页：突出用途、遮挡效果与首次使用流程，折叠更多截图及开发操作；补齐环境要求、Windows 安装命令与平台限制，纠正 CLI 必须设置 Token、邮件外发、密钥回退及快照明文降级说明；演示数据改用独立临时目录且脚本与服务共享路径 | 23 个本地链接/锚点、11 个 Bash 代码块语法、9 条 pnpm 命令与引用路径检查通过，CLI `--help` 通过；仅文档修改，未重新执行完整测试、安装、打包或真机摄像头验证。

---

## 26-10-13-1540 首次提交前验证与前端修复

- **目标**：按用户授权分批提交、推送前完成检查；发现验证失败后，经用户确认修复问题，不绕过校验。
- **涉及文件及主要修改**
  - `apps/web/src/features/boss/rules.tsx`、`settings.tsx`：仅在新的服务端数据到达时同步表单，移除 Effect 内同步更新状态；保留草稿编辑、重新加载覆盖及保存语义，合并 React 类型导入。
  - `apps/web/src/features/boss/stats.tsx`、`timeline.tsx`：查询键包含请求参数与时间范围，满足缓存依赖校验。
  - `apps/web/src/features/boss/form-sync.test.tsx`：新增 4 条浏览器回归测试，覆盖异步加载、相同数据重渲染保留编辑、新数据同步、保存内容及旧版配置归一化。
  - `apps/web/src/context/search-provider.test.tsx`：将模板项目的旧文案、旧路由断言同步为实际中文界面与识务路由；用独立夹具继续验证嵌套导航，没有删除有效断言。
  - `.gitignore`：忽略 Vitest 浏览器失败截图目录 `__screenshots__/`，不删除已有截图。
- **影响范围**：管理界面的状态同步、缓存键和测试；未修改后端、安全策略、依赖版本或发布工作流。测试浏览器仅补齐本机 Playwright 缓存。
- **验证结果**
  - 敏感文件/常见凭据扫描未发现已确认真实秘密，唯一连接串候选为 Alembic 标准模板；用户数据、密钥、依赖、构建产物及测试失败截图不在待提交清单中。
  - 后端使用独立临时数据目录与测试密钥执行 `python -m pytest -q tests`：61 passed、14 skipped。
  - 桌面端 `node --test apps/desktop/test/actions.test.js apps/desktop/test/windows.test.js`：11 passed。
  - 前端 `pnpm --dir apps/web test`：9 个测试文件、71 条浏览器测试通过；`lint`：0 errors、3 warnings；`build`：TypeScript 与 Vite 构建通过。
  - 独立只读复核未发现本次表单同步与缓存键修复的 blocking 问题；该结论不替代上述实际运行结果。
- **遗留事项**：缺视频素材的 14 条测试仍跳过；`filters.tsx` 保留 3 条 Fast Refresh 警告；未重新验证真机摄像头、完整桌面用户路径或三平台安装包。上游活体模型单独来源/许可、安装包许可文件纳入、发布 runner 和正式签名配置仍需后续核实，本次不打发布标签、不发布安装包。
