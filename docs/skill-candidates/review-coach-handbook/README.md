# 运营教练复盘：平台指标手册（PUBLISH-MONITOR 块 C，2026-11-04，未发布）

此目录只有文件清单和 SHA-256，不包含手册原文。原文在私密仓库 graylum-skills 的 `review-coach/handbook/`。

- 版本：2026-11-04（Owner 当日"按推荐定"）。
- 文件：`SKILL.md`（正文就是教练方法：对话加载和周复盘读同一份，见 `coach/method.ts`）、`workflow.yaml`、`handbook/douyin.yaml`、`handbook/tiktok.yaml`（手册代码读取，结构见 `packages/api/src/services/publishMonitor/coach/funnel.ts` 的 `handbookSchema`）。
- 加载：发布后设环境变量 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`（见 `coach/handbooks.ts`）；未设置时复盘行为不变。
- 发布前按 graylum-skills README 的发布流程核对：上传后逐文件哈希必须等于本清单。

## staging 发布记录

- 2026-11-04 发布到 staging：版本 1，skill 8f7c8623-1e06-44e7-bfa4-b710c710af40，revision f4918e1a-c492-4c0a-b2ea-52efd2a3a7fe，包哈希 5344d8745660738f98fdddeea3b1092be3aba74955afd572d37fdbad699a22b0；原文来自 graylum-skills 提交 7f6d77f。`method.md` 仍是草稿，改动需重新发布成新版本。

- 版本 2（待发布）：方法正文并入 `SKILL.md`、删除 `method.md`，手册加 min_views 500；本目录清单已是版本 2 的文件（graylum-skills bdf3011）。版本 1 里 `method.md` 的哈希不再使用。
- 2026-11-04 发布到 staging：版本 3，skill 8f7c8623-1e06-44e7-bfa4-b710c710af40，revision ced02ecd-87b9-4122-bc07-3c2f9e6c81bf，包哈希 a5c47c7061c6042e237f291d7f4bf7366e3dd406841c8020bee292a284971c01；只在 `SKILL.md` 的“怎么诊断”和“用户在对话里发后台截图时”各加几句（周复盘没有单条诊断时请用户发后台截图；截图来源要注明；用户纠正以最新为准），原文来自 graylum-skills 提交 be2df97。本目录清单已是版本 3 的文件（SKILL.md 5602 字节）；其余四个文件与版本 2 相同。
- 2026-11-05 发布到 staging：版本 4，skill 8f7c8623-1e06-44e7-bfa4-b710c710af40，revision 167035dd-f1f3-4327-a904-5f1574d19b43，包哈希 ec8b87624052ae11f61128de4dc782396c4cfdf518d11a7c17f1ca3e83a50c4e；`SKILL.md` 加了季度战略体检、月度占比对比、有候选作品时点名请用户补截图（原文来自 graylum-skills 提交 6f923d6，6641 字节）。本目录清单已是版本 4 的文件，其余三个文件与版本 3 相同。包哈希按仓库的 `packageHash`（`skills/loader.ts`）用 skill、revision、目录名和逐文件哈希重新算过，开头 ec8b8762 和结尾 0c4e 与 staging 发布时记录的包哈希一致。
