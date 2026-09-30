# ENTITLEMENTS：会员权限配置实施方案

> 状态：方案已获总控通过；PR-1 实施中。日期：2026-09-30。
> 依据：最新 `origin/staging`，基准 `28af1e34f3947389f14d85401c0f33b91fca7a60`。
> 风险：**high**（会员权限、权益配置；后续涉及追加迁移）。
> 当前授权：在 #540 继续 PR-1；完整 CI 全绿后交总控审，尚不进入 PR-2。
> 全程不连接远程数据库；不自行标 ready、合并、部署、应用迁移或修改外部配置。

## 1. 目标、依据与交付边界

复用现有会员计划和后台设置，补上 Fusion 两种模式的权限及资料库总空间配置，
提供供服务端准入使用的权益读取和判定。ENTITLEMENTS 与之后的 PAY-COMMON
由本会话这一名 writer 先后负责；本文不提前实施 PAY-COMMON。

产品依据：

- [Master Plan](../MASTER_PLAN.md) §7.1 ENTITLEMENTS（第 441 行）、§7.3 钱路线
  （第 489–491 行）、§4.5 后台配置（第 276–283 行）、§10 D3/D4（第 669–676 行）。
- [FUSION](FUSION.md) 第 40 行必测项 10：接口不能绕过会员权限；降级后新请求用新等级，
  已在进行的执行照常完成、结算。
- [LIBRARY-VOICE](LIBRARY-VOICE.md) 第 11 行额度机制、第 36–42 行必测项 9–15：
  按字节原子占用，原文件加提取文字都计入；超额后保留查看、下载、删除和文风画像。
- [AGENTS](../../../AGENTS.md) 和 [ENGINEERING](../../ENGINEERING.md)；新逻辑走统一 Runtime、
  BILL2，数据库结构只通过 `packages/db/migrations/` 追加，不修改历史迁移或 `schema.ts`。

本任务不实现 Fusion 并行/评审引擎、资料库上传/提取/占用账本、支付渠道、订单和退款。
这些消费者尚未存在，不能把纯判定单测称为它们的端到端权限验收。第 5、8 节明确接线位置
和消费者必须补齐的测试；后台配置基础交付与消费者接线完成分别报告。

## 2. 开工核验与 writer 重叠

已核对仓库 remote、GitHub staging 和保护规则，读取该基准的 AGENTS/ENGINEERING，
并检查相关 open PR、已有 worktree 和当前两条并行任务的本机执行记录。
此步唯一写入文件是 `docs/launch/tasks/ENTITLEMENTS.md`，与已知候选不重叠。

| 并行工作 | 当前证据与潜在交界 | 本任务处理 |
| --- | --- | --- |
| [#537 B1b](https://github.com/Crnobog9527/GraylumAI_vercel/pull/537)，head `1caa9721c8755c517f63c5f2f978be0148684593` | 当前候选只含擦除 SQL 测试/说明；Handoff 为后续迁移保留 0150；后续处理 Runtime/正文擦除 | 本方案无文件重叠；未来不抢 0150，不改擦除函数或 Runtime 表；实现前再核对其最终范围 |
| [#538 注销防刷 PR-E](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538)，head `58b403567d0da60121f48996f2a937ae25463a43` | 当前候选只有 erasure-e README；已读任务记录：赠送涉及 `trpc.ts`、账务 RPC；新摘要表、注销封闭函数和环境校验 | 本方案无重叠；未来不改 `trpc.ts`、赠送/注销/密钥；只读 `profiles` 不等于写同一张表 |
| [#539 staging 90 项约束预检](https://github.com/Crnobog9527/GraylumAI_vercel/pull/539)，head `e8c6c23b74ff30f20c2c5525f4e843f3523c20d6` | 当前只读预检及本地预检测试；未来迁移及 `built-fingerprint.json` 是共享面 | 本方案不分配编号、不改指纹；未来迁移和指纹须等该 writer 交付或由总控明确写入顺序 |
| [#497](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497)，head `192b22647497d11ac588ebc1387c52a6bfd2c90f` | 修改 Runtime `admission.ts`、执行器、OPC 和集成测试；后续 Fusion 属同一 Runtime 线 | 本任务提供权益服务，不直接修改其正在写的文件；消费者接线由 Runtime writer 在交付后使用 |
| [#530](https://github.com/Crnobog9527/GraylumAI_vercel/pull/530)，head `827151c9b855008037c1586a5b9393dacf665191` | 待合并的评审模式规则修订，改 Master Plan/FUSION/ENGINEERING；D3/D4 未改变 | 不修改这些文件，不把提案当 staging 已生效规则；实现消费者前读届时已合并版本 |
| [#536](https://github.com/Crnobog9527/GraylumAI_vercel/pull/536)、[#533](https://github.com/Crnobog9527/GraylumAI_vercel/pull/533) | 工程/建库治理文档、CI；注销/密码 UI | 本方案不修改其文件；实现前读取届时有效治理和检查 |

出现**同文件、同表或共享指纹写入重叠**时，先停该部分，记入 PR 的 Handoff，
由总控安排先后；不能以分支/worktree 隔离为由继续写。无重叠的方案和测试准备可继续。
上表为方案提交前快照；后续有新候选时刷新相关证据，不要求 Owner 搬运已有证据。

## 3. 现有机制盘点

以下均为上述 staging 基准的**仓库文件事实**，不证明远程库当前数据/配置。
源码链接固定到同一 SHA，行号不会随之后的 staging 漂移。

| 表、接口或页面 | 文件与行号 | 已有能力及限制 |
| --- | --- | --- |
| `profiles` | [0000_core_prerequisites.sql:31–44](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/baseline/0000_core_prerequisites.sql#L31-L44) | `membership_level` 默认 free，另有角色、账号状态、积分；没有会员到期时间列 |
| `membership_plans` | [0000:261–280](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/baseline/0000_core_prerequisites.sql#L261-L280) | 等级、月/年价、积分、赠送、折扣、展示 features、历史保留天数、导出/批量导出、上下架；旧开关是 text；仅主键，不保证同等级唯一 |
| 上下文额度、支付价格映射 | [0009:15–38](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0009_context_length_limit.sql#L15-L38)、[0012:7–9](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0012_stripe_payments.sql#L7-L9) | 现有 `max_context_messages` 和月/年 Stripe 价格字段；不等于 Fusion 模型数或资料库空间 |
| `system_settings` | [0000:107–111](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/baseline/0000_core_prerequisites.sql#L107-L111) | `key` 主键 + jsonb value，可存单一全局 D3 设置，无需新配置表 |
| `user_subscriptions`、`payment_orders` | [0012:11–48](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0012_stripe_payments.sql#L11-L48) | 订阅计划关联、周期、取消标记、状态和支付履约；订单/订阅渠道与结算事实仍属于钱路 |
| 钱包与积分发放 | [0000:95–105](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/baseline/0000_core_prerequisites.sql#L95-L105)、[0045:13](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0045_subscription_credit_grants.sql#L13)、[0105:8](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0105_v3_bill2_authoritative_runs.sql#L8) | `credit_transactions`、`subscription_credit_grants`、`bill2_runs` 已有；余额/预扣与会员功能许可独立，不新建钱包 |
| 公共套餐 API | [settings.ts:48–62,344–402](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/settings.ts#L344-L402) | `getMembershipPlans` 查 active 计划，返回价/积分/features/购买可用性；没有 Fusion/空间字段，展示文案不是授权来源 |
| 系统设置 API | [settings.ts:66–87,219–288](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/settings.ts#L219-L288) | 公开设置有 key 白名单；管理员单项/批量写已存在，部分 key 有专用校验；D3 要补同样的单项/批量校验 |
| 后台设置读取、计划写入 | [admin.ts:157–163,2499–2660](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/admin.ts#L2499-L2660) | `getSettingsDashboard`、计划 create/update/delete；现有权限字段只含导出，计划创建不校验 level 唯一 |
| 后台会员权限页面 | [admin/settings/page.tsx:105–174,525–637](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/apps/web/src/app/admin/settings/page.tsx#L525-L637) | 已有“会员权限”标签、按计划保存、成功读回；添加两开关和空间输入复用这里 |
| 后台套餐管理 | [admin/packages/page.tsx:334–423,717–918](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/apps/web/src/app/admin/packages/page.tsx#L334-L423) | 价格、积分、展示权益和上下架入口；不在会员权限页复制价格/支付配置 |
| 会员展示与当前用户 API | [SubscriptionCard.tsx:472–492,835](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/apps/web/src/components/profile/SubscriptionCard.tsx#L472-L492)、[user.ts:11–16](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/user.ts#L11-L16) | 展示来自套餐 features/默认积分文案；用户等级来自 profile，不能把客户端缓存作为准入依据 |
| 现有导出权限检查 | [chat.ts:137–159,489–580](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/chat.ts#L137-L159) | 服务端读当前 profile 等级及 active 计划，export/batchExport 拒绝无权者；只借鉴机制，不给旧聊天扩功能 |
| 购买/后台改等级 eligibility | [membershipEligibility.ts:10–61,365–503,692–764](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/membershipEligibility.ts#L365-L503) | free/pro/gold；读取订阅和订单，识别 admin_override、欠费、取消、退款信号、冲突；`allowed` 表示购买/变更许可，**不是功能使用许可** |
| 管理员改会员等级 | [admin.ts:1271–1388](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/admin.ts#L1271-L1388)、[subscriptionOverrides.ts:1–25](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/subscriptionOverrides.ts#L1-L25) | 已有有效订阅禁止直接改等级、人工覆盖及审计；ENTITLEMENTS 不改变这些写入规则 |
| 支付更新、降级和退款交界 | [stripeFulfillment.ts:2985–3127](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/stripeFulfillment.ts#L2985-L3127)、[0042:42–82](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql#L42-L82)、[subscriptionCreditGrants.ts:1195–1214,2340–2370](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/subscriptionCreditGrants.ts#L1195-L1214) | 钱路维护 profile 等级与订阅/发放；取消降级已有处理；退款/发放的最终 RPC 需沿现有契约，不能用这张配置表另算付费有效期 |
| 当前 Runtime 输入与重放 | [admission.ts:22–28,66–74,156–181](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/runtime/admission.ts#L66-L74) | 普通/自动/Skill/整理，无 Fusion 选择类型；先查原 request 重放，服务端冻结 context，后调用准入 RPC |
| Runtime 持久化和原子准入 | [0106:12–24,324–338](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0106_runtime_sessions.sql#L12-L24)、[0138:6–61](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0138_runtime_stopped_pending.sql#L6-L61) | 已有 request 幂等、冻结 payload、作用域验证、一次原子创建执行及 BILL2 预扣；无会员 Fusion 检查 |
| 当前资料库 | [library/page.tsx:63–100](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/apps/web/src/app/library/page.tsx#L63-L100)、[opc.ts:195–224](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/routers/opc.ts#L195-L224)、[opc/service.ts:480–510](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/services/opc/service.ts#L480-L510) | 业务/账号/选题/成果版本的查看编辑；无文档登记/字节占用，不可把记录条数当文件额度 |
| 当前文件上传 | [upload/route.ts:75–109](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/apps/web/src/app/api/upload/route.ts#L75-L109) | 工单图片、中转、5×1024² 字节；不是 LIB-DOCS 上传，不扩充此入口代替资料库 |
| 身份与管理员授权 | [trpc.ts:443–500](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/api/src/trpc.ts#L443-L500)、[0033:4–9](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0033_package_config_admin_write_posture.sql#L4-L9)、[0148:247–254](https://github.com/Crnobog9527/GraylumAI_vercel/blob/28af1e34f3947389f14d85401c0f33b91fca7a60/packages/db/migrations/0148_db_baseline_convergence.sql#L247-L254) | protected/adminProcedure、账号状态、service-role 管理写；客户端只有配置读取授权，新增字段不能带来普通用户写权限 |

## 4. 最短正确路径、D3/D4 与迁移

### 4.1 复用与真正缺少的能力

- **权威保持不变**：会员配置在 `membership_plans`，系统 Fusion 数量上限在
  `system_settings`；当前已授予等级仍由现有 profile/订阅/支付履约维护。
- **复用**：现有 settings/admin/user routers、管理员读写链路、会员权限标签、
  统一 Runtime 冻结 payload、request 幂等和 BILL2。只增加有当前消费者需求的本地服务 helper。
- **缺少**：计划上的两个强类型开关和字节额度、D3 key 的校验、供新执行用的权益解析/判定、
  后台输入与读回。未来上传还缺原子占用能力，属于 LIB-DOCS；这里不提前建占用表。
- `features` 仅是营销文本，不能保证类型、原子边界或接口许可；把完整权益再塞进一份
  system_settings JSON 会与会员计划形成双重来源。因此推荐给原计划增加字段，不建权益表、
  配额账本、队列、通用权限框架或第二条执行链。

### 4.2 默认值与后台落地

| 等级 | 评审开关 | 对比开关 | 资料库总空间 |
| --- | --- | --- | --- |
| free | false | false | 50 MB |
| pro | true | true | 500 MB |
| gold | true | true | 2 GB |

推荐新增 `allow_fusion_review boolean`、`allow_fusion_compare boolean`、
`library_storage_bytes bigint`（非负，服务端校验安全整数边界）。这是技术字段建议，
不改变既有 text 导出开关。精确字节按第 7 节已确认 P1 的十进制值写入。

迁移分两步设值：先加 nullable 字段，只对未初始化字段按等级填 D4，检查全部已知等级
都有合法值后再 NOT NULL/CHECK；未知等级或缺/重复计划由预检指出，不能猜成免费或高等级。
连续执行第二次不得覆盖管理员已改值。之后新建计划通过现有 create API 的同一份默认解析
按 level 写 D4；更换计划 level 要显式保存其权益，不能保留意外的高等级授权。
不修改价格、积分、导出、历史天数或已成交权益；不凭空创建带价格的计划记录。

在 `/admin/settings` 的“会员权限”标签增加两种模式的独立开关及总空间输入，
`updateMembershipPlan` 保存并从 dashboard 读回；保存失败不展示成功、不用客户端默认值伪装读回。
输入显示可读单位，保存精确整数 bytes；0 空间可用于关闭新增上传，仍允许保留数据的读/删。
公共套餐和登录用户权益投影只返回允许展示的配置，不返回账号/支付映射或管理员内部设置。

**D3**：复用 `system_settings` 新增 `fusion_compare_max_models`，默认整数 **4**，
只在 key 不存在时初始化。后台“Fusion 设置”的小区块维护，同一设置不在会员页另存副本；
保存单项和批量 API 均限制整数 2–8，系统 **8** 为宿主硬上限，不能由前端或数据库大值绕过。
新请求取当前值，非整数、缺配置或读失败拒绝新 Fusion；已有冻结执行仍用原值。
最小可选数量按第 7 节已确认 P4 为 2。
D3 是对比参与模型数量，不是评审模型数、工具调用次数、SDK turns 或预扣调用预算。
当前 D3 对获准使用对比的等级统一生效，不引入未规定的 Pro/Gold 数量差异。

**系统级文件数量保护**不属于会员权益，不添加到本表/会员页/套餐文案；具体数值和原子占用
由 LIB-DOCS 的 host 限制决定，与会员总空间分别检查。

### 4.3 是否新表、迁移、兼容与恢复

- **新表：不需要。迁移：需要**，已有计划表没有这些可配置、可验证字段；一份追加迁移
  补字段、数据初始化、范围约束及 D3 初始 key。不改 baseline、历史 SQL 或原会员 RLS/grants。
- 不增加 level UNIQUE 或重写计划选择，先由总控提供第 9 节数量预检；存在同等级多计划时
  停相关实现，采用第 7 节 P3 的批准方案。
- 新字段是 additive，旧读取/显式写不需要改价钱路；但新增计划写入和严格返回 schema 必须
  同 PR 更新。配置读取异常 fail-closed，不能长期偷偷回退 D4，掩盖缺失迁移。
- 新迁移编号以**合并时的 staging**为准；此方案不占号。撞号时只改本任务新文件名，重跑
  `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built` 并提交新指纹。
- 本地：空库建库、迁移连续两次（结构与配置均不变）、管理员修改后重跑不覆盖、
  非管理员新会话读/写权限、account-open 审计、回退后结构比对。恢复材料放 tests 目录，
  不作为自动下迁移；只撤本任务新增字段/key，不改用户文件、订单、余额或已运行执行。
- 结构指纹按 `packages/db/baseline/README.md`：本地生成 built 指纹；staging 指纹/差异由
  总控执行后提供，应用前标明 pending，应用后凭新只读证据更新。Agent 不抓远程指纹。

## 5. 服务端准入、降级与运行中执行

### 5.1 配置解析服务

新增小型 `services/membershipEntitlements.ts`（名称可按实现约定调整），提供明确的
当前权益读取、Fusion mode/count 判定和 library byte-limit 返回；router 只做 zod 和调用。
优先复用 membershipEligibility 的事实加载/状态分类；若需共用其内部函数，只提取这部分
到局部 helper 并保持购买/后台改等级结果不变，不新增通用状态机。
不得调用购买 action 后把 `allowed` 当功能开关：已订阅用户的重复购买被拒，不能据此拒绝使用。

读取用户身份只来自现有认证上下文，重新查服务端当前事实；不接受客户端 level/权益/bytesUsed。
配置缺失、多行歧义、未知等级、读取错误或会员事实冲突返回稳定的 `ENTITLEMENTS_*` 错误，
通过现有 publicError/前端安全提示；失败不产生预扣或模型/存储调用。
读取自己的既有资料与创建新增收费/上传动作分别授权，不能因 fail-closed 或降级锁住删除入口。
到期/退款/欠费的精确判定按第 7 节 P2 答案；不新建到期 cron、不擅改付费业务政策。

### 5.2 Fusion 接线位置与原子边界

FUSION-REVIEW/COMPARE writer 在新增宿主准入动作中调用权益服务：

1. 认证、账号状态和作用域验证后，先查该用户原 `requestId` 是否已准入，并核对原请求相同。
2. 仅对**全新执行**读取最新会员事实、两个模式开关、D3 限制和管理员允许模型清单；
   验证模式、数量、模型集合，在创建整组执行/预扣/调用前拒绝无权请求。
3. 当前 API 检查不能消除“检查后恰好降级”的竞态：实际消费者创建 RPC 在同一事务里
   重读并锁定相关会员/配置事实、判定、冻结权益和创建执行。锁序沿现有 BILL2/Runtime，
   不在网络模型调用期间持锁；在该 RPC 中做最小扩展，不另开一族权限 RPC。
4. 把服务端产生的有效等级、mode、模型上限及配置值/时间冻结到已有 execution/BILL2 input；
   客户端传入快照不能授权。整组的一次准入是成员子执行/汇总后续步骤的授权来源。
5. 已准入的 prepared/running/恢复中执行和同 request 幂等恢复沿原快照完成，不重新按新等级
   拒绝、不重开运行单/重复预扣；下一次新的 request 用新等级。对比结果采用也不重复收费。

“进行中的照常完成”仅指会员等级/管理员权益配置变化；不绕过账号封闭、来源删除、作用域
撤销或用户取消的既有安全检查。冻结值也不能复活已经取消/封闭的执行。
不影响没有 Fusion 权限的用户走普通定位到报告；升级提示不能成为定位流程的必经步骤。

目前没有可接线的 Fusion 创建入口；本任务不在普通 Runtime 上造一个 Fusion 占位入口，
也不改 #497 的准入文件。消费者 RPC 的事务验证/并发测试是 FUSION 的交付必需项。

### 5.3 LIB-DOCS 接线与降级

LIB-DOCS 的签名上传发放/原子占用 RPC 使用同一最新总空间：发地址前锁定用户的
占用记录和权益，按申报字节占用；完成时按原文件 + 提取文字实际字节补占/退回，
同时查独立系统数量保护。不信前端聚合，不在客户端 sum 后放行。

降级、到期或退款之后，**新发起的上传**用新额度；已有文件超额不自动删，
仍可查看、下载、删除，文风画像继续用。清理遵守先删除对象、确认成功后释放占用，
过期占用复用现有 cron 清理，不在本任务创建新表/队列/调度器。
降级期间已发放地址的上传按第 7 节已确认 P5：仅已原子占用的上传保留原预算；
不得扩大预算，新的上传地址按新额度。

## 6. 与 PAY-COMMON 的交界

- ENTITLEMENTS 负责“某等级配置什么、当前新动作可否发起”，PAY-COMMON 负责
  “购买何时成交、升降级/到期/退款何时变更当前权益事实、订单原渠道、幂等履约和凭证”。
- 不用会员配置读取触发支付同步或远程订阅查询；不在这里改月/年积分、余额、折扣、价格、
  Stripe/Waffo、退款政策或账务状态。
- PAY-COMMON 复用这里的配置和会员事实解析；新购买渠道切换不能改变已有订阅/订单原渠道。
  如需将事实读取从 Stripe 特定形态扩为 Waffo，沿原订阅/订单增加最小渠道能力，
  不维护第二份会员真相表。具体表字段在 PAY-COMMON 方案单独审。
- 同 writer 先交付 ENTITLEMENTS，再开 PAY-COMMON 实施；后者升级/到期/退款完成后
  重跑跨任务测试：旧执行正常结算，新动作立即按新等级，文件超额可读可删、不可新传。
- 权益配置编辑不是重新购买，默认不改运行中的快照；付费有效期政策不会通过后台开关隐式变更。

## 7. 已确认的产品边界与 staging 事实

依据：[总控方案审查结论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/540#issuecomment-5907228308)
（2026-09-30，审查 head `cb98c9add69e1d0929ab01df0fe157c8e72a0346`）。
方案通过；以下明确区分 Owner 决定和总控接受的推荐，不再作为待定项。

| 问题 | 确认答案 | 决定来源 |
| --- | --- | --- |
| P1：容量单位 | 十进制 50,000,000 / 500,000,000 / 2,000,000,000 bytes；页面标清单位与用量，数据库存 bytes；不改变 D6 单文件限制 | 总控接受推荐 |
| P2：支付或权益状态不确定 | Owner 原则“说不清就先不给”：欠费、付款未完成、退款待核对等不确定状态不能新发起付费会员功能，提示解决付款或联系支持；不设隐含宽限期。已准入执行完成并结算；原资料可读、下载、删除；付款恢复后新请求立即恢复 | **Owner 决定**，由总控评论记录 |
| P3：配置归属与下架 | 按一等级一份权益配置实现；下架不撤销已授予权益。本 PR 不加 level UNIQUE；将来若确有需要另提理由与方案，不任意挑重复记录 | 总控接受推荐并提供预检事实 |
| P4：模型数 | 对比最少 2；获准等级共用 D3 默认最多 4、系统上限 8；不另设 Pro/Gold 数量差异。评审数量由 FUSION 后台配置，不套用 D3 | 总控接受推荐 |
| P5：上传期间降级 | 原子占用时冻结额度；已占用上传按原额度完成且不扩大原预算；新地址按新额度。消费者实现时与 LIB-DOCS writer 对齐；不能仅凭签名地址放行未原子占用的上传 | 总控接受推荐 |

总控以 `BEGIN READ ONLY … ROLLBACK` 执行第 9 节查询，并确认
`transaction_read_only = on`。**这是总控提供的 staging 证据，Agent 未连接远程库。**

- `membership_plans` 的 level/is_active/allow_export/allow_batch_export 为 text；
  三个新权益列均不存在；`profiles` 的 membership_level/status 为 text。
- `user_subscriptions.membership_plan_id` 为 uuid、status 为 text、current_period_end
  为 timestamptz；当前订阅表为空。
- free/pro/gold 各一条且均 active；缺失或重复等级、未知等级、被引用下架计划均为 0。
- `fusion_compare_max_models` 记录数和 number 类型记录数均为 0。

PR-1 沿现有会员计划加强类型字段，D3 沿 system_settings；不增加新表或通用权限框架。
总控安排合并顺序 **#537（0150）→ #538（0151）→ #539 → 本任务**；
迁移编号以最终 staging 为准。前序合并前仅输出临时本地指纹，
不写入 `built-fingerprint.json`；同步 staging 后再运行
`node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`。

## 8. 建议 PR 拆分与必测项

方案原为 **PR-0**；经总控允许，#540 继续承载 **PR-1**，之后另开 **PR-2**。
两个实现切片均为 high，不把支付或消费者引擎捆进来。
每个 PR 均按 draft → 完整 CI 全绿 → 总控审 → 标 ready 请 Codex 机器人审
→ Owner 批准 → 总控合并；Agent 不自行推进越过当前审阅边界。

### PR-1：数据配置 + 服务端权益解析/判定 + 管理 API

范围：一份追加迁移、built 指纹和必要差异记录、本地 SQL 测试/恢复材料；
`services/membershipEntitlements*`、必要的现有 membership facts 局部提取；
`routers/admin.ts`（dashboard/create/update）、`routers/settings.ts`（D3 写校验/安全投影）、
`routers/user.ts`（当前用户最小权益投影）及对应测试。不改 `trpc.ts`、Runtime、
现有退款/支付/注销函数。超限文件通过同目录局部拆分缩小，不调高基线。

必测（明确允许/拒绝两条路径）：

- D4 三等级、新建计划默认和独立开关；Pro/Gold 两种模式允许，free 默认两种拒绝；
  管理员对任意等级改开关后，服务端实际读取生效，拒绝路径没有预扣/调用副作用。
- 当前正常会员读自己权益允许；未登录、未验证、封闭/禁用用户及伪造身份/等级拒绝；
  不越过现有账号状态和数据归属检查。读取其他用户权益不能靠传 ID 获得。
- 管理员保存与读回允许，普通用户/匿名直接 API 和直接表写拒绝；实际新会话测 ACL/RLS，
  不只测 adminProcedure mock。单字段更新保留其余价格、积分、导出和权益字段。
- D3 默认 4：4 允许/5 拒绝；管理员改 8 后 8 允许/9 拒绝；非法整数、超界、
  恶意请求、批量写与单项写一致；模型数最小值按 P4；模式及模型目录许可独立检查。
- 数据库/配置读失败、空结果、多行歧义、未知等级拒绝；购买已存在的 `allowed=false`
  不能被误认为使用许可 false；会员状态矩阵按已批准 P2，原购买/后台改等级回归不变。
- 本地模拟等级改动：新权益读取立刻变化；冻结值不被配置编辑覆盖。
  这只证明服务契约，**不是 Runtime 实际进行中/并发验收**。
- 迁移首次/连续二次结构相同，D4 数据初始化及管理员改值不被第二次覆盖；空库建库、
  fingerprint 仅含预期对象、非负 bytes/类型约束、account-open 审计和回退结构比对。
- 用隔离本地身份验证新字段读/写，不连接远程库。总控提供预检事实前不写迁移数据修复。

### PR-2：后台会员权限及 Fusion 数量设置 UI + 配置展示

范围：`admin/settings/page.tsx` 同目录/`components/admin/` 局部拆分；
新增控件和 component/browser tests；会员套餐展示若需展示新权益，使用现有返回投影，
只增加配置驱动的字段展示，不重设计套餐/购买流程，不提前展示尚未交付的功能为可用。

必测：

- 管理员编辑 → 保存 → 离开/刷新读回 → 调用服务端判定，两个 Fusion 开关各自生效；
  正确 MB/GB 与 bytes 往返不丢精度，不把系统文件数量上限当会员权益显示。
- 合法空间和 D3 值保存允许；负值、非整数/溢出、超过 8、未保存草稿、无权限 API 调用拒绝；
  保存/读回失败有安全错误，不展示假成功，刷新不恢复本机假值。
- 前端隐藏/禁用仅辅助：绕开 UI 的拒绝由 PR-1 实际服务判定覆盖。
- 本地浏览器验证会员标签、Fusion 设置、移动宽度、保存/读回和错误路径；
  使用本地测试数据、网络拦截或本地库，不暗中访问 staging。staging 的技术 smoke
  由总控执行并贴证据；Owner 产品验收入口为 `/admin/settings` 的“会员权限”和“Fusion 设置”。

### 消费者交付时必须补的真实接线测试

不增加本任务第三个 Runtime/上传实现 PR；在 FUSION、LIB-DOCS 的相应 PR 中完成：

- Fusion：免费直接调用拒绝；Pro/Gold 允许；后台关一种模式只拒该模式；4/5、8/9 边界；
  模型白名单；准入与降级/配置编辑并发时有明确事务顺序；原 request 恢复和跨轮子执行
  用原授权，换 request 用新授权；拒绝零扣费，进行中照常完成与结算且只扣一次。
- LIB-DOCS：空间内允许/超过拒绝，并发上传不能合计突破；实际补占、申报小实际大、
  提取后超额及独立系统文件数上限；降级超额可看/下载/删、拒绝新上传，画像继续使用；
  失败/删除中断/过期占用先删对象再释放；在途降级按批准 P5；实际单文件 D6 上限。
- PAY-COMMON：支付履约、到期、退款或管理员合法变更后新动作读取新权益，旧执行和
  账务照常完成；订单渠道切换不改已有订阅原渠道。均限本地或批准的非生产测试模式。

每个实现 PR：frozen install、API 单测、相关网站单测、web/API lint/typecheck、
代码大小、safeguards、迁移账本检查；有迁移则 local-only replay/write-built、幂等、
允许/拒绝和恢复 SQL 测试。有 runtime/UI 改动则对应本地/经允许的非生产浏览器证明。
远程必需 CI 不因文档或本地已通过而缩减；未运行、跳过、失败分别记录。

## 9. 请总控执行的 staging 只读事实

Agent 未连接任何远程数据库。总控已执行并在审查评论提供结果，见第 7 节。
保留以下 **SELECT** 供必要时由总控复核；只输出对象/等级/状态分类和数量，不带账户、UUID、支付编号、密钥、
配置中其他 key/value。第一条缺字段/表时，停依赖它的后续语句，不能把 SQL 报错当 0。

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'membership_plans' AND column_name IN
        ('level', 'is_active', 'allow_export', 'allow_batch_export',
         'allow_fusion_review', 'allow_fusion_compare', 'library_storage_bytes'))
    OR (table_name = 'profiles' AND column_name IN ('membership_level', 'status'))
    OR (table_name = 'user_subscriptions' AND column_name IN
        ('membership_plan_id', 'status', 'current_period_end')))
ORDER BY table_name, column_name;

SELECT level, count(*) AS plan_count,
       count(*) FILTER (WHERE is_active = 'true') AS active_plan_count
FROM public.membership_plans
GROUP BY level ORDER BY level;

SELECT count(*) AS missing_or_duplicate_known_levels
FROM (VALUES ('free'), ('pro'), ('gold')) AS expected(level)
WHERE (SELECT count(*) FROM public.membership_plans p
       WHERE p.level = expected.level) <> 1;

SELECT count(*) AS unsupported_level_count
FROM public.membership_plans
WHERE level IS NULL OR level NOT IN ('free', 'pro', 'gold');

SELECT count(*) AS referenced_inactive_plan_count
FROM public.user_subscriptions s
JOIN public.membership_plans p ON p.id = s.membership_plan_id
WHERE p.is_active <> 'true'
  AND s.status IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid');

SELECT status, count(*) AS subscription_count,
       count(*) FILTER (WHERE current_period_end IS NULL) AS no_end_count,
       count(*) FILTER (WHERE current_period_end <= now()) AS ended_count
FROM public.user_subscriptions
GROUP BY status ORDER BY status;

SELECT count(*) AS d3_setting_count,
       count(*) FILTER (WHERE jsonb_typeof(value) = 'number') AS numeric_count
FROM public.system_settings
WHERE key = 'fusion_compare_max_models';
```

这组查询用于配置/事实预检，不是完整权限验收。不返回明文或私有行内容；
缺/重计划、未知等级、已有未识别 D3 设置要先解释，不能写清理/覆盖迁移自行修正。
后续需要函数、约束或授权原文时另贴针对对象的只读 SELECT，由总控执行。

## 10. PR-1 实现与验证入口

- `membershipEntitlementConfig.ts`：强类型输入、仅创建时使用的 D4 默认值及局部补丁；
  `membershipEntitlements.ts`：当前用户权益读取和 Fusion 判定；只读现有事实，不触发支付同步。
- 复用 `membershipEligibility.ts` 的退款信号识别；不使用购买 `allowed` 做功能许可。
  购买读取器只看最近十条并任取 managed 订阅，不能证明准入唯一性，因此新判定直接查询
  所有当前订阅（最多取二条用于检出歧义），没有当前记录时才看最新历史记录；
  旧 admin_override 与已终止记录留在历史回退，不把旧人工授予误判成第二份当前订阅。
  这只是同一事实表的本地读取逻辑，不增加持久化来源或状态机。
- 付费 profile 无任何订阅/订单时沿既有人工授予路径；有支付记录而缺少订阅、未知状态、
  多个未终止订阅、缺失周期、计划不匹配均不给新付费权益。明确终止或周期到期使用 free；
  past_due/incomplete/unpaid、待履约订单和退款核对走 payment_attention，提供安全提示。
- `user.getEntitlements` 身份只来自 protectedProcedure；无 service-role 读取能力则拒绝，
  用户输入不能提供 ID/等级/额度。输出不含订阅、订单或后台内部数据。
- 计划 create/update 沿原 admin API，局部拆到 `adminMembershipPlans.ts`；实际变更等级
  必须显式给出三项权益，并用读取到的原 level 作为写入条件防止并发绕过。只改单项不重置其余字段。
- 追加迁移暂用 `0153_membership_entitlements.sql`，不动 RLS/grant/旧 text 字段、不新增表/唯一约束。
  先迁移后发布新 API；迁移前新 API fail closed。迁移后、API 发布前旧创建接口不能创建新计划，
  因此该短暂窗口暂停后台新增计划；旧读取/购买使用的字段不变。回退先退 API，再由总控按审批备份
  三列/D3 配置后决定是否回退结构；回退会丢失这四项新配置，不能说成无损。
- 本地 SQL 入口：`node packages/db/tests/entitlements/run-local.mjs --local-only`。
  用隔离 Docker、合成身份、新 psql 会话验证默认值、越界拒绝、管理员值重复应用保留、
  ACL/RLS 允许/拒绝及结构回退；临时指纹不写共享 built 文件。
- API/SQL 单测不替代消费者原子事务。Fusion/LIB-DOCS 实际并发准入、恢复与冻结仍按第 8 节交付。
- #497 也修改 `scripts/code-size-baseline.json`；本次 admin.ts 缩小后需降低对应条目，
  该共享文件暂不修改，已在 PR Handoff 请总控协调。前序 #537/#538/#539 和 built 指纹继续按第 7 节顺序。

## 11. 当前交接状态

- 已完成：方案、staging 事实及 P1–P5 审查结论归档；PR-1 获准开始。
- PR-1 实施和验证结果以 PR Handoff 的当前 head 为准，本文不静态宣称 CI 全绿。
- 共享指纹等待前序合并；本地测试限 local-only，不应用远程迁移。
- 下一步：完成 PR-1 及完整 CI 后交总控审；保持 draft，不自行标 ready、触发机器人审或合并。
