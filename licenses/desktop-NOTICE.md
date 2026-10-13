# 桌面端（Electron）

`apps/desktop/` 是自研的 Electron 主进程。这里记录其中**来自第三方**的部分。

| 项 | 来源 | 许可 |
| --- | --- | --- |
| Electron 运行时 | https://github.com/electron/electron | MIT |
| 提示音 `assets/sounds/*.wav` | Facenox 上游仓库的 `app/public/assets/sounds` | AGPL-3.0（见 `facenox/LICENSE`） |
| 图标 `assets/icons/*.png` | 本项目自制 | AGPL-3.0 |

上游 Facenox 仓库：https://github.com/facenox/facenox ，锁定 commit
`10a4b64f05403aed3e7c864ae71cd574546da9f6`。

Electron 的 MIT 许可要求保留版权声明；提示音随 AGPL-3.0 代码一并归入本产品的
AGPL-3.0 发布范围，上游归属见 `../NOTICE` 与 `facenox/NOTICE.md`。
