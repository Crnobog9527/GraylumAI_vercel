# 定位 Skill 第 15 版候选清单（RESEARCH-TOOLS 对标发现修正）

本目录仅记录私有 Skill 原文的前后 SHA-256 与修改说明。候选原文位于本机 `~/.graylum/research-tools-rt6/v15`，不进仓库；不在此 PR 直接发布或改动线上 Skill。

- 基线：第 14 版候选，按 `positioning-mentor-v14/file-hashes.json` 中的 SHA-256 固定。
- 仅修改 `README.md`、`SKILL.md`（版本 2.7.0 → 2.8.0）和 `references/02-benchmark-analysis.md`。
- 发现阶段的关键词作品不能证明账号最近 30 天不活跃。卡片标记“活跃度待取数确认”，后续由 `benchmark_fetch` 最近作品确认。
- `NOT_ENOUGH_CANDIDATES` 表示数据已取到、只是可选账号不够。说明“已找到 N 个可选、需要 8 个”，建议补充关键词或请用户提供账号主页链接；不得说成没取到数据。

## 发布边界

按现有管理员 Skill 包发布流程，在该 PR 合并后由总控发布为不可变的新版本，并使用第 14 版作为 `expectedVersion`。本任务只准备候选文件及其校验材料，不对 staging/线上 Skill 执行发布；回滚按现有流程发布上一版本内容的新版本，不撤销历史版本。

## 验证

`skill-candidate-v15.test.ts` 校验清单只列出两处变更、旧版哈希链及 Skill 规则文字。设置 `V3_MENTOR_SKILL_V15` 时会继续执行真实 `validatePublication` 与资源加载验证；未提供私有目录时该部分跳过，不能算发布验证通过。
