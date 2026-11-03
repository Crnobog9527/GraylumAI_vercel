# 运营教练复盘：平台指标手册（PUBLISH-MONITOR 块 C，2026-11-04，未发布）

此目录只有文件清单和 SHA-256，不包含手册原文。原文在私密仓库 graylum-skills 的 `review-coach/handbook/`。

- 版本：2026-11-04（Owner 当日"按推荐定"）。
- 文件：`handbook/douyin.yaml`、`handbook/tiktok.yaml`（代码读取，结构见 `packages/api/src/services/publishMonitor/coach/funnel.ts` 的 `handbookSchema`）。
- 加载：发布后设环境变量 `PUBLISH_MONITOR_HANDBOOK_PACKAGE`（见 `coach/handbooks.ts`）；未设置时复盘行为不变。
- 发布前按 graylum-skills README 的发布流程核对：上传后逐文件哈希必须等于本清单。
