# shadcn-admin

`apps/web/` 目录基于 **shadcn-admin** 修改而来。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/satnaing/shadcn-admin |
| 锁定 commit | `e16c87f213a5ba5e45964e9b67c792105ec74d26` |
| 许可 | MIT（见同目录 `LICENSE`，© 2024 Sat Naing） |

## 改动范围

- 移除 Clerk 认证与全部演示页面。
- 改为「识务」中文管理界面：视频源、一键采集、人员管理、规则设置、时间线、统计、设置。
- 新增 `src/features/boss/`（业务功能）、`src/lib/api.ts`（对接本地服务）。

MIT 允许修改与再分发，条件是保留上方的版权声明与许可全文 —— 同目录 `LICENSE` 即为原件。
