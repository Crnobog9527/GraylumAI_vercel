# 运营教练复盘：平台指标手册（PUBLISH-MONITOR 块 C，2026-11-04，未发布）

此目录只有文件清单和 SHA-256，不包含手册原文。原文在私密仓库 graylum-skills 的 `review-coach/handbook/`。

- 版本：2026-11-04（Owner 当日"按推荐定"）。
- 文件：`SKILL.md`、`method.md`（教练方法，周复盘从这里读，见 `coach/method.ts`）、`workflow.yaml`、`handbook/douyin.yaml`、`handbook/tiktok.yaml`（手册代码读取，结构见 `packages/api/src/services/publishMonitor/coach/funnel.ts` 的 `handbookSchema`）。
- 加载：发布后设环境变量 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`（见 `coach/handbooks.ts`）；未设置时复盘行为不变。
- 发布前按 graylum-skills README 的发布流程核对：上传后逐文件哈希必须等于本清单。

## staging 发布记录

- 2026-11-04 发布到 staging：版本 1，skill 8f7c8623-1e06-44e7-bfa4-b710c710af40，revision f4918e1a-c492-4c0a-b2ea-52efd2a3a7fe，包哈希 5344d8745660738f98fdddeea3b1092be3aba74955afd572d37fdbad699a22b0；原文来自 graylum-skills 提交 7f6d77f。`method.md` 仍是草稿，改动需重新发布成新版本。
