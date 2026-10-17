# 定位 Skill 第 14 版候选清单（RESEARCH-TOOLS RT-6）

此目录只有前后 SHA-256 清单和修改说明，不包含私有 Skill 原文。完整候选保存在本机私有目录
`~/.graylum/research-tools-rt6/v14`，不进公开仓库。

- 基线：staging 定位 Skill 第 13 版，revision `eae22201-461e-44b9-b191-c3d034ccbf53`，
  package hash `72af5b86dbb182a78dd4c5d1049bf1819aab22c8dc0e9e0592001adcb6e5b371`，23 个文件
  （2026-10-17 从 staging 只读读回清单，逐文件哈希与本机第 13 版一致）。
- 依据：[RESEARCH_TOOLS_PLAN](../../launch/implementation/RESEARCH_TOOLS_PLAN.md) 第 1.1–1.6、2.1 节和第 6 节 RT-6 行；
  Master Plan 第 2.1 节 R11（凑够 3 个合格对标才出报告，不提供"跳过"）。方案里写的"第 13 版"已被 FUSION-REVIEW PR-0 用掉，
  所以本次是第 14 版。

## 改了什么（`file-hashes.json` 里 `changed=true` 的 7 个文件，其余 16 个字节不变）

1. `references/02-benchmark-analysis.md`（主要改动）
   - "合格"分成两部分：**数据合格**由系统按真实取数判断（粉丝 1 万–20 万、最近 30 天内更新、平台在支持清单里），
     导师不能改也不能估；**适合他学**由导师按 4 条判断并说明理由。原来的"最近 6 个月内更新"按产品规则改为 30 天。
   - 数字只用系统取数结果并带来源编号，取不到写"未获取"；网上案例只作背景、注明"真实性待考证"，不计入合格。
   - 研究工具的用法：每次回复最多调一个；卡片确认编号、发现编号、本会话合格数只从宿主给的 `hostTurnContext.research` 读。
   - 用户有对标：请他把主页链接发在消息里，导师在回复这条消息时 `benchmark_fetch`（来源 `{kind:"user_message"}`）。
   - 用户没有对标：`propose_keywords` 发关键词卡，**确认前不搜** → `benchmark_discover` → 候选卡 → `benchmark_fetch`
     （来源 `{kind:"candidate", confirmationId}`）→ 不够 3 个用 `propose_more_candidates`；没有"跳过"。
   - 取不到、平台不支持、次数用完、余额不足都照实说，不说成"没有合适的账号"。
   - 删掉旧的"有搜索工具时不用等用户确认关键词"；维度 A–G、跨账号总结压缩成清单，内容不减（第 2 步上下文很紧）。
   - 互动率改为系统口径：每条作品（点赞 + 评论 + 分享）÷ 播放，取中位数；没有播放量时写"未获取"。
2. `references/01-discovery.md`：对标一问改成要主页链接；有工具时在回复带链接的消息时就取数，只给账号名时请他补链接。
3. `SKILL.md`：阶段一第 5 项、阶段二对标门槛、自检清单对标一条；version 2.6.0 → 2.7.0。
4. `references/research-policy.md`：对标数字只用取数工具结果，取不到照实说。
5. `workflow.yaml`：`reportGeneration` 加 `"minQualifiedBenchmarks": 3`（宿主对定位报告本来就强制至少 3 个，这里写明声明）。
   步骤、字段、资源清单都不变。
6. `EVALS.md`：E17 对齐；新增 E26（先确认关键词、编号只从宿主上下文读、每次最多一个研究工具、数字只来自取数、不跳过）。
7. `README.md`：2.7.0 变化说明和已知限制。

## 怎么发布、怎么回滚（staging 数据写入，由总控执行）

见 PR 描述"Skill 发布清单"。要点：用管理员 Skill 包发布（`skills.publishPackage`，`expectedVersion: 13`）生成不可变的第 14 版，
不覆盖第 13 版；已有草稿按创建时冻结的 revision 读取，不受影响。回滚不要用"撤销版本"（撤销会让绑定第 14 版的草稿历史不可用），
而是把第 13 版文件原样再发布一次（成为第 15 版，内容与第 13 版相同）。

## 测试

`packages/api/src/services/opc/skill-candidate-v14.test.ts`：
- CI 里：清单只改了上面 7 个文件；用"修改前"哈希重算出的第 13 版 package hash 与 staging 读回的完全一致。
- 本机设置 `V3_MENTOR_SKILL_V14` 指向私有候选目录时：逐文件哈希、真实发布校验 `validatePublication`、资源加载，
  检查 02 里提到的工具名都真实存在、关键规则文字都在、报告声明能被 `reportManifest` 解析为 3。CI 没有私有候选时跳过这一条，
  不能当作发布验证。
