# 定位 Skill 第 13 版候选清单（FUSION-REVIEW PR-0）

此目录只有前后 SHA-256 清单和修改说明，不包含私有 Skill 原文。完整候选保存在本机私有目录，不进公开仓库。

- 基线：staging 定位 Skill 第 12 版，revision `0479891f-a1e9-4b44-9596-9c2f67ec406b`，
  package hash `a8528efd05f7bf8ca4a835ba9ab03f45a2e2d24a594ab50efa03794b1b56a7d6`，23 个文件（发布前从 staging 读回，逐文件哈希与库里一致）。
- 依据：Master Plan 第 2.1 节 2026-10-12"评审团改为自研、评审仍不联网"；[FUSION-REVIEW 实施方案](../../launch/tasks/FUSION-REVIEW.md) 第 4.2 节。

## 改了什么

只改 `references/review-rubric.md` 两句，其余 22 个文件字节不变（`file-hashes.json` 里 `changed=false` 的 `sha256` 等于 `beforeSha256`）：

1. "评审团可以联网搜索来核对……"改为：评审不联网，只依据报告本身和前面已经收集的资料（用户事实、对标研究结果及其来源）；
   需要外部核实的说法标为"待核实"，并建议用户补充资料，不能用推测覆盖用户提供的事实。
2. "联网查到的信息要附来源并注明真实性待考证"改为"前面对话里联网收集到的信息要附来源并注明真实性待考证"，
   表明这是对已收集资料的要求，不是让评审去联网。

"对标是否有至少 3 个合格账号"的完成检查**保留不动**（Owner 2026-10-12 R11 决定：凑够 3 个合格对标才出报告）。

## 怎么发布、怎么证明旧草稿不受影响

- 用现有管理员 Skill 包发布（`skills.publishPackage` → `atomic_publish_skill_package`）生成新的不可变版本，不覆盖第 12 版。
  清单里的 `tasks`、`requiredCapabilities`、目录名和每个文件的 `requires` 与第 12 版相同。
- 已有草稿按创建时冻结的 revision 读取 Skill（v3Package 集成测试"current and pinned history"已覆盖：发布新版本后，
  按旧 revision 读到的仍是旧内容）。本次另加 `packages/api/src/services/opc/skill-candidate-v13.test.ts`：
  - CI 里：清单只改了 review-rubric 一个文件；用清单里的"修改前"哈希重算出的第 12 版 package hash 与 staging 记录完全一致，
    说明第 12 版的身份没有被改动。
  - 本机设置 `V3_MENTOR_SKILL_V13` 指向私有候选目录时：逐文件哈希、真实发布校验 `validatePublication`、资源加载，
    并检查 review-rubric 不再有"评审团可以联网"、有"评审不联网"和"待核实"、仍保留"至少 3 个合格账号"。CI 没有私有候选时跳过这一条，
    不能当作发布验证。
- staging 发布后的读回核对和旧草稿检查记录在 PR 里。

## 不在这里做

- 评审 Skill 包（评审和汇总提示词）随 PR-4 一起写：它的输出格式和 PR-4 的意见 schema、`steps`、`changeNotes` 绑定，
  到时候和宿主检查一起验证。
- 真实模型下"REPORT-GEN 自检不再提联网"的行为测试要付费调用，等总控开好本任务的 staging 测试窗口后补做；之前为 NOT_RUN。
