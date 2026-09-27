# 定位导师 Skill 候选清单（未发布）

此目录只有前后 SHA-256 清单及修订说明，不包含私有 Skill 原文。完整候选保存在本次本机交付证据目录，由 Owner 审阅并单独授权发布。

基线：staging v2 revision `d6301c8e-e179-4ade-bbaf-361cb05fe41a`，package hash `2c46008ed80977cb46c2efe52aec2f1e8fe74d9835b490ddb8208db880359303`。

只修改 SKILL.md 与 references/01-intake.md：移除固定回复模板和首轮多题要求，明确宿主当前字段模式与独立使用模式的作用范围。workflow.yaml 六步九问和其余 17 文件字节不变。候选文本版本1.1.0，正式发布必须经现有 Admin 包发布与新不可变 revision，不覆盖v2。

本地以 V3_MENTOR_SKILL_CANDIDATE 指定包含 social-media-commercial-strategist 子目录的私有候选目录，可运行 skill-candidate.test.ts 的完整包校验/加载测试。CI 只验证公开清单契约；没有私有候选时明确跳过加载，不能当真实模型验证通过。

已有 draft 保持原 revision，不篡改历史冻结请求/round/Skill。私有包发布及已有 draft 显式版本升级需独立授权和验证；仓库变更不自动发布。
