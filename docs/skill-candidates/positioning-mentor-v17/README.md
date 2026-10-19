# 定位 Skill 第 17 版候选（对标不足兜底，Owner 2026-10-20 选 B）

本目录只保存私有 Skill 原文的前后 SHA-256 与修改说明，候选原文位于本机 `~/.graylum/research-tools-rt6/v17`，不进仓库；本 PR 不发布或改动线上 Skill。

- 基线：staging 已发布第 16 版，revisionId `a4efef7e-471d-427c-9c5e-0eb2642d8d4b`（本地留存的发布回执为 HTTP 200，版本 16）；发布前再读线上版本核对没有漂移，并先存第 16 版快照。
- 只改 6 个文件，其余 17 个字节不变：`SKILL.md`（2.9.0 → 2.10.0）、`references/02-benchmark-analysis.md`、`references/reporting.md`、`assets/report-template.md`、`EVALS.md`（新增 E27）、`README.md`（变更记录）。
- 内容：搜满两轮、仍不足 3 个但至少 1 个合格时，系统出选择卡（"继续找对标"推荐 / "用现有 N 个对标先生成报告"）；导师推荐继续找、不替用户选、不写预计积分；用户选"先生成"后按现有合格账号往下做，不编造账号或数据；报告在一句话结论或"五、对标账号分析"开头写"对标样本不足"（只有 N 个可学账号、结论参考性有限、建议之后补找）。14 个章节和 `workflow.yaml` 不变。
- 是否允许生成由宿主决定（迁移 0318 的报告准入），Skill 只负责说清楚、写进报告。
- `expectedVersion: 16`；发布按 Owner 10-18 批准的管理员 Skill 包流程，用 admin 测试账号在 staging 执行，发布前把改动摘要交总控转 Owner 批准；发布本身不做付费验证（Owner 10-18）。

## 验证

`skill-candidate-v17.test.ts` 检查 23 个文件的第 16 版前后哈希，只允许上面 6 处变化；本机设置 `V3_MENTOR_SKILL_V17` 时，继续运行真实 `validatePublication` 与资源加载验证。不提供私有目录时该部分跳过，不能当作发布验证。
