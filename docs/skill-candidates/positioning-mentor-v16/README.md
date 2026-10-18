# 定位 Skill 第 16 版候选（RESEARCH-TOOLS 对标发现修正）

本目录只保存私有 Skill 原文的前后 SHA-256 与修改说明，候选原文位于本机 `~/.graylum/research-tools-rt6/v16`，不进仓库；本 PR 不发布或改动线上 Skill。

- 基线：staging 已发布第 15 版，revisionId `1ec66964-517f-4709-a9fd-dea7b7f8de63`；本地留存的发布回执为 HTTP 200，版本 15。
- 保留第 15 版 REPORT-VISUAL 对报告格式的改动。本候选仅改 `README.md`、`SKILL.md`（2.8.0 → 2.9.0）和 `references/02-benchmark-analysis.md`。
- 发现阶段不按关键词命中的作品日期判断活跃度；候选卡显示“活跃度待核对”，取数后才按最近 30 天规则判断。
- `NOT_ENOUGH_CANDIDATES` 表示数据已取到、只是可选账号不够；按工具数量说明“已找到 N 个可选、需要 8 个”，建议补关键词或请用户提供账号主页链接，不得说成没取到数据。
- `expectedVersion: 15`；发布由总控在合并后按现有管理员 Skill 包流程执行，本任务不发布。

## 验证

`skill-candidate-v16.test.ts` 检查 23 个文件的第 15 版前后哈希，只允许上面三处变化；本机设置 `V3_MENTOR_SKILL_V16` 时，继续运行真实 `validatePublication` 与资源加载验证。不提供私有目录时该部分跳过，不能当作发布验证。
