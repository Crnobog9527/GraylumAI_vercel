# GraylumAI 项目地图（给不写代码的负责人）

用大白话说明代码结构，主体于 2026-09-27 按 staging 核对；计费说明于 2026-10-03 按 BILL-PAYG PR-A 契约补充，未表示该候选已合并或迁移已应用。具体接口和状态以当前代码为准；执行规则见 [AGENTS.md](../AGENTS.md)，产品规划和施工顺序见 [Master Plan v12](launch/MASTER_PLAN.md)，技术栈和写代码的规矩见 [工程规范](ENGINEERING.md)。

## 1) 这个项目是什么

- 一个 pnpm + Turborepo 的多包仓库：网站在 `apps/web`（Next.js），后端接口在 `packages/api`（tRPC），数据库结构在 `packages/db/migrations`（Supabase Postgres）。
- 用户在网页上和 Agent 对话，Agent 通过 OpenRouter 调用大模型。默认 v1 按供应商实际成本及冻结费率计费；本次 v2 核心改用冻结标价计算名义费用，暂时仅供测试创建，不切换用户入口。

## 2) 用户能看到的页面

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 首页 | `/` | 新用户的定位入口 |
| 对话 / 定位分析 | `/positioning`、`/positioning/[草稿]` | 顶部导航"对话"和侧栏"新对话"都进这里；将按 v12 第 3 节重做 |
| 选题工作区 | `/positioning/[草稿]/topics` | 定稿后的周选题 |
| 工作会话 | `/runtime?session=…` | 侧栏里点开某条对话或选题进入 |
| 资料库 | `/library` | 查看和编辑已采用的选题、稿件、定位版本；将按 v12 第 5 节增加上传和语料库 |
| 功能广场、搜索 | `/workbench/marketplace`、`/workbench/search` | 侧栏入口 |
| 个人中心 | `/profile` | 订阅、设置、工单、历史 |
| 旧对话 | `/chat` | 旧引擎，主导航已不再指向它，但落地页、个人中心历史和后台还有链接；计划下线（v12 第 8 节） |
| 管理后台 | `/admin/*` | 用户、模型、成本、Skill（模块）、会员计划、设置、诊断等 |

模型管理的“思考设置”中，“试一次”通过 `modelReasoning.tryOnce` 调用
`services/models/tryReasoning.ts`，使用已保存的用途设置和固定线路发送一个短问题，
仅返回耗时、正文是否存在及供应商报告的用量/费用。该诊断由平台付费，不扣用户积分；
仅管理员可用，同模型每个服务实例 30 秒一次，无自动重试，输出最多 4096 token，
同时受模型和线路上限约束。预算不能在此上限内留足回答空间时直接拒绝。
它不验证真实交互的工具调用；真实 staging 验证须另行批准。

## 3) 两套对话引擎（新功能只接新的）

| | 新：统一 Runtime | 旧：`/chat` 链路 |
| --- | --- | --- |
| 用在哪里 | 定位、选题、工作会话、侧栏对话 | `/chat` 普通对话 |
| 主要代码 | `packages/api/src/services/runtime`（官方 Agent SDK）、`services/bill2`（计费）、`routers/runtime.ts`、`routers/opc.ts`、`services/opc` | `apps/web/src/app/api/ai/stream/route.ts`、`services/modelRouter.ts`、`services/contextManager.ts`、`services/billing.ts` |
| 计费 | BILL2：一次用户操作一个运行单。默认 v1 整单预扣；PAYG v2 核心按每个 call 预留并结算，按累计应计积分取整差额结算，暂时仅测试可创建。一个运行单可以包含多个调用 | 旧的预扣 / 结算 / 退费 |
| 前途 | 所有新功能都接这里 | 新工作区接管自由对话后下线 |

两套共用同一个积分余额和流水，没有第二个钱包。

BILL-PAYG 本次只做 [PR-A 计费核心](https://github.com/Crnobog9527/GraylumAI_vercel/pull/617)，
具体契约见 [BILL2 说明第 0 节](launch/tasks/V3-BILL-2-provider-authoritative-billing.md#0-bill-payg-pr-av1-保留v2-逐调用预留)：

- v2 每次调用先冻结可用积分范围内的额度，再按累计应计差额扣款；不足以覆盖本次费用的差额由平台承担，不留待充值后追收。
- 供应商实际费用 c 完整保留；用户名义费用 n 按输入、输出和请求标价计算，不使用缓存折扣，有分时价时取最高时段价。可靠 token 缺失时按 `min(c,U)` 兜底；实际费用也未知时不当成零。
- 费用未知的已派发 call 保留冻结额度并等待核对；未派发且能可靠撤权的 call 释放一次。注销同样区分这两种状态，不能把未知费用的冻结额度直接清空。
- 平台承担报表及管理员提醒接口属于 PR-A；提醒未设定时返回“未启用”。已确认故障的补偿单列实际退回金额，净扣减去这笔金额，不抹掉原始成本或平台承担记录。
- Runtime 接线是后续 PR-B；价格变动提醒是 PR-C；前端等待、继续和提醒页面另做。PR-A 不改变默认 v1，不代表已开放边用边扣。

本段说明合同和实现范围；当前测试、CI、审查及迁移状态以 PR 的 Handoff 为准。


缓存代码位置：当前 Runtime 使用 `packages/api/src/services/runtime/promptCache.ts`；
旧诊断仍引用 `services/promptCacheBuilder.ts`。没有调用方的旧 `services/promptCache.ts`
及其专属测试已删除，不影响上述两个模块。

后台诊断的“速率限制”只检查本地限流器，“消费熔断”只读取旧配置及默认值；
两项都不证明请求链路已强制执行，报告明确标为警告。RLS 的服务端表可访问性检查
同样不构成用户隔离验证。

## 4) 数据库核心表（按业务看）

- 用户与会员：`profiles`（含会员等级）、`membership_plans`、`credit_packages`、积分流水
- 定位与内容：`artifact_*`（项目、轮次、确认、正式版本）、`opc_*`（草稿、业务、账号、选题、内容版本）
- 新 Runtime 与计费：`runtime_*`（会话、执行、历史）、`bill2_*`（计费运行单、每次调用、供应商成本回执）
- Skill：`skills`、`skill_revisions`、`skill_packages`（不可变版本）、`modules`（后台上架的模块）
- 模型与设置：`ai_models`、`system_settings`
- 旧对话：`conversations`、`messages`
- 其他：工单、公告、诊断、日志

迁移文件在 `packages/db/migrations/*.sql`，只能新增，不能改已有的。

## 5) 改动影响面速查

- 改对话、定位、Agent 行为：`packages/api/src/services/runtime`、`services/opc`、`apps/web/src/app/positioning`
- 改计费：`packages/api/src/services/bill2` 和相关迁移（敏感改动，按 AGENTS.md 第 4 节在测试模式下验证；staging 由 AI 验证后合并，上正式环境须 Owner 批准）
- 改 Skill 上传发布：`packages/api/src/services/skills`、`apps/web/src/app/admin/prompts`
- 改后台统计和设置：`packages/api/src/routers/admin.ts`、`routers/settings.ts`、`apps/web/src/app/admin/*`

## 6) 常用命令

见 [工程规范第 7 节](ENGINEERING.md)。

## 7) 历史稳定化记录（不是当前验证结果）

- `.env.example` 改为安全占位符，移除真实密钥样式值。
- 修复 `admin.getUserDetails` 消息统计逻辑（按用户对话 ID 统计消息）。
- 下线旧 `chat.sendMessage` Echo 入口，避免误接旧链路。
- 当时的 API 测试从 4 个失败修复为 0 个失败。

## 8) 如何提出任务

说明期望的用户行为、当前问题和验收结果即可。Agent 自行定位页面、接口、文件范围和验证方式，不需要 Owner 选择技术命令或使用固定模板。

## 9) 发布资料

以下材料可用于查找历史证据与技术要求，不能替代当前候选的验证、授权或完成判断；当前执行流程以 `AGENTS.md` 为准：

- `docs/archive/2026-09-c2/STRICT_SIGNOFF_STATUS.md`
- `docs/RELEASE_PREP_CHECKLIST.md`
- `docs/runbooks/PRE_RELEASE_REHEARSAL.md`
- `docs/STRIPE_ENABLEMENT_CHECKLIST.md`
