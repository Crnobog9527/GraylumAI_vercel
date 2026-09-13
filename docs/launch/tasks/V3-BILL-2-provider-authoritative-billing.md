# V3-BILL-2 — Provider-authoritative 统一计费开工契约

任务身份：`V3-BILL-2`；依赖：`BILL-1`；后继：`V3-RUNTIME`。任务映射见 [OPC 实施映射](V3-OPC-implementation.md)，产品规则来自[架构 §11](V3-OPC-growth-agent-architecture.md#11-provider-authoritative-聚合计费)与 [Master Plan 修订 §7](../Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md#7-provider-authoritative-原子计费)。

状态：**开工规格，功能 NOT_RUN**。当前仅文档交付；功能须 Owner 另行选择。本任务未来实现风险为 **high**（计费/权限/前向数据库迁移），本次不改代码、SQL 或任何远端配置。以下接口名表示实施契约，不声称仓库已经提供这些函数，也不预占迁移编号。

## 1. 当前代码与复用边界

代码证据锚点为 staging `9ceaab3f22c01ae6b64ea4c0d51015196f4097b0`。仅确认源码存在与行为，不宣称当前远端 schema、旧验收或供应商能力已验证。

| 当前入口/对象 | 当前行为与本批处置 |
| --- | --- |
| [billing.ts](../../../packages/api/src/services/billing.ts)：`BillingService.preDeduct/settle/refund/settleAbort/finalizeAISuccess/finalizeAIFailure` | 复用服务边界与原子 RPC；当前 `calculateTokenCostWithPricing` 使用 JS number/local token price，`estimatePreDeductCredits` 会被 maxPreDeduct 截断。仅保留作旧模式/保守报价参考，不能用作新官方财务真值或通过不足的预算 |
| [0061](../../../packages/db/migrations/0061_refund_1b_expired_quarantine_repair.sql) `atomic_pre_deduct`；[0057](../../../packages/db/migrations/0057_refund_1b_actual_refund_accounting_repair.sql) `atomic_settle/refund/abort_settle` | 唯一 `profiles.credits`，锁 profile→grant，预扣绑定原期/其他来源；保留 quarantine、reversed/termination 拦截、实际恢复额。不能只读最早 0003 或重建这些规则 |
| [0058](../../../packages/db/migrations/0058_refund_1b_canonical_metadata_merge_repair.sql) success/abort 与 [0059](../../../packages/db/migrations/0059_refund_1b_failure_period_metadata_repair.sql) failure finalizer | 既有消息、用量、消费与终结事务；成功路径绑定 conversation 并另写消费，不能把它当成草稿聚合 finalizer 直接再次调用。新聚合终结应复用底层钱路原语，适配而非双写 |
| [0044 流水语义](../../../packages/db/migrations/0044_credit_transactions_v2_semantics.sql)、[creditLedger.ts](../../../packages/api/src/services/creditLedger.ts)、[billingReconciliation.ts](../../../packages/api/src/services/billingReconciliation.ts) | 保留 `credit_transactions`、`billing_history`、spend/非 spend、账务来源和现有对账入口；新预留/终结必须解释每次余额变化，不新增第二钱包或另设账本 |
| [agentSlice/accounting.ts](../../../packages/api/src/services/agentSlice/accounting.ts)、[runner.ts](../../../packages/api/src/services/agentSlice/runner.ts) | `sliceCallId(executionId, sequence, phase)`、beforeCall/recordCall、固定预算、禁自动重试可复用；现行 reply 至多两次、summary 独立、逐调用预扣/本地计价，不能等同新聚合计费 |
| [0084](../../../packages/db/migrations/0084_agent_slice_call_accounting.sql)、[0085](../../../packages/db/migrations/0085_agent_slice_summary_identity.sql)、[0095](../../../packages/db/migrations/0095_agent_slice_final_commit.sql)、[0097](../../../packages/db/migrations/0097_agent_slice_prepared_recovery.sql) | 复用持久调用、阶段身份、结果原子保存、prepared 恢复/令牌轮换模式；现有表的 project/round 和每调用 pre_deduct 不直接冒充 draft/run，保留历史结构并新增适配 |
| [普通聊天可靠性](../../testing/ordinary-chat-reliability.md)、[0078](../../../packages/db/migrations/0078_ordinary_chat_requests.sql) | 复用原请求恢复、结果先保存、余额错误 fail closed、dispatch 未知不重发；第一批不替换整个聊天执行入口 |
| [research/store.ts](../../../packages/api/src/services/research/store.ts)、[0071](../../../packages/db/migrations/0071_v3_research_billing.sql) | 研究有独立 agentkey-credit 报价/实报/unknown，不能将报价或 Tavily usage 单位当 USD 实付；保留既有调用方。本批规定收据接口，工具接入统一 Runtime 时才适配，禁止同一工具同时走旧收费和新聚合 |
| [0079 消费读取权限](../../../packages/db/migrations/0079_ai_consumption_read_contract.sql)、[credits router](../../../packages/api/src/routers/credits.ts) | 保留本用户消费、旧 request/model/Skill 元数据及历史呈现；新增 run 级投影，不公开原始收据/凭证/私有输入，不把 pending 展示为零费用成功 |

不动：Stripe checkout/升级/订阅发放/退款策略、历史 baseline、生产 env、连接器、完整 SDK Session、六步页面、Fusion 产品、旧路由/上下文/清理服务。必要的账务兼容修复限新 run 的接入面；不重做 BILL-1 或批量改历史账单。

## 2. 归属、运行单与调用身份

### 2.1 两种归属

服务端验证的 tagged union：

- `positioning_draft`：actor + 持久 draft ID；project/work item 必须为空。只能执行定位允许的问答/研究/整理/计划操作。
- `work_item`：actor + project ID + work item ID，校验实际父子及所有权；draft 字段为空，适用时验证社媒定位准入。

第一批交付最小持久 scope 绑定和所有权验证，可复用现有成果/草稿存储或添加窄绑定；不得创建占位项目、只接受客户端任意 UUID，或用 projectId 缺省跳过权限。不要求实现完整 Session：预留 nullable `session_ref`，为空时只供本批账务服务与隔离测试，不能声称可启用正式 Agent。第二批在首次正式调用前把真实 Session 与 scope 原子绑定；仅能从空绑定一次，已有值不能改变，不能以晚绑定将运行单转给另一用户/作用域。

一次用户收费操作一张 run，六步流程可有多张。自动附属于本操作的模型/工具/整理调用都进入这张 run；后续独立触发的整理才新建 run。普通保存和确认承接不产生模型调用或运行单费用。草稿承接为一/多个项目只新增来源引用，已结算与未决 run 不迁移、不复制、不重置。

### 2.2 最小数据契约

| 对象 | 必须持久化并校验的字段 |
| --- | --- |
| run | run ID、actor/request ID、scope、可选 session_ref、operation/mode、Skill revision（适用时）、规范输入/来源版本 hash、私有输入/结果的受控恢复引用、contract_version、冻结报价规则/兑换规则/商业倍率、预算上限与调用数上限、唯一 pre_deduct ID、状态/版本/终结结果 |
| local call | call ID、run ID、单调 sequence、role/phase、provider+调用账户命名空间+模型、冻结请求 hash、输入/输出/工具上限、精确成本上界、dispatch capability/版本、已发出标记、取消/响应事实和时间 |
| receipt | receipt ID、local call、provider/account、实际 generation/response ID（可未知）、币种/单位、官方成本原始十进制及精确规范值、usage/cost details、覆盖组/总项或子项类型、完整性/冲突状态、取得方式、adapter 协议版本、来源与 hash/时间 |

`UNIQUE(actor, request_id)` 绑定完整冻结负载；同 ID 同负载返回原状态，不再预扣或 dispatch；不同负载/作用域/模型/revision 必须冲突拒绝。run/pre_deduct 一对一；`UNIQUE(run, sequence)` 与 call ID 唯一。provider generation 唯一性按 provider+账户命名空间，不用 API key 明文作命名空间；一次外部调用只归一条 local call。不同查询来源的同 generation 可有多份收据观测，但只选一个权威成本用于结算。

输入 hash 不是恢复内容。原输入/固定版本和已保存结果以权限保护的引用保留；日志/公开账单只保留脱敏定位信息。作用域删除或撤权禁止再次执行/读取私有正文，不能抹掉未决账务关联。

### 2.3 提供给第二批的服务接口

- `prepareRun(scope, requestId, frozenInput, limits)`：认证/账号状态/权限/模型/revision/规则有效后，在事务内幂等建 run、一次预留并返回 run ID；失败无调用。
- `claimCall(runId, sequence, frozenCall)`：事务验证调用总数、剩余预算、身份与取消状态，先写 call，再原子领取一次 dispatch capability；只有明确提交成功且本进程持有有效 capability 才可发网络请求。
- `recordReceipt(callId, trustedEvidence)`：仅可信服务端 adapter 提交，绑定 provider/account/ID，原始证据保留、去重及冲突校验。浏览器/模型不传“最终价格”。
- `closeRun(runId, outcome)`：禁止再增调用，持久化交付成功/确认故障失败/用户取消的证据引用；`finalizeRun` 只按 §5/§6 在数据库终结一次。
- `requestCancel(runId)`：只取消未来 dispatch，已发出的调用按已知事实核对；读取 `readRun` 无预扣/dispatch/结算副作用。服务端 `recoverRun` 有界查询及终结，与 UI 轮询分离。

先持久化 dispatch 再发送仍有崩溃窗口；提交响应丢失先读回，不因读到 dispatched 就给新进程派发权。prepared 可用 token 轮换回收，仅在同锁下证明未 dispatch；超时或 lease 过期不能回收已发出的调用。

## 3. 官方收据与精确金额

### 3.1 信任和覆盖关系

只接受经过服务端 adapter 验证的供应商官方实际成本。adapter 明确已验证的 response/generation 字段、是否最终、工具/缓存/推理是否已包含、币种和查询限制；没有证据不声明协议支持。官方正文/查询相互一致才可升级为 complete；只有明确最终零收费收据可用 0。缺成本是 null/cost_pending，不能用 token 估价、max budget、catalog quote 或使用次数代替。

同一 receipt 相同 hash 为幂等重放；相同 provider ID/覆盖范围的金额、币种、模型或最终性冲突，保留两份不可变观测及理由，停止该 run 自动结算。不能“最后写入覆盖”、取较小值或猜测哪个正确。已有终态后冲突也只新增核对事项，不重开消费。供应商明确给出的更正必须有可验证版本/关联；涉及已终结用户金额仍须独立授权的补偿操作。

普通多调用：每个独立外部请求形成一个成本覆盖组，先去重，再汇总所有组。一个请求中的工具/缓存/推理若已含在官方总额，子明细仅展示；另行收费且有独立官方收据的工具才能另计，保留其调用身份和原单位换算依据。

Fusion：整次 Fusion 调用可只对应一条 local call 和一份官方总收据。内部参与/分析/外层模型仅是覆盖组内证据，不要求伪造独立 generation/子成本；总额存在时不再累加子项。独立于 Fusion 外另行发生的调用建立另一覆盖组。覆盖关系无法证明、总项与子项矛盾或有未覆盖的已发出调用时不结算。本批只实现该数据/算账契约与 fixture，不实现 Fusion 编排或开启用户入口。

### 3.2 精度与冻结规则

- 应用层财务值用规范十进制字符串/精确 decimal 或定点整数；数据库 NUMERIC。不得先 JSON.parse 为 number 再 stringify 回来冒充精确值；必须从原始响应使用保精度解析。
- 明确接受精度、范围和单位；拒绝负数、非有限值、格式错误、溢出及超精度，不能静默截断。积分结果必须在现有 INTEGER 范围内。非 USD 成本只在有明确、冻结且可追溯兑换规则时进入 USD 聚合；否则 cost_pending，不假定与 USD 等价。
- run 创建时冻结 creditsPerUsd、商业倍率、币种兑换规则版本、报价/安全边际、模型/工具上限。配置缺失/非法时拒绝开始新 run；不能沿用当前 helper 的隐式默认回退。运行中管理员改价仅影响新 run。
- 计算 `C = ceil(sum(不重叠官方成本组的精确 USD) × frozen creditsPerUsd × frozen multiplier)`，只在整个 run 最后进位一次。子项不能独立取整后求和；零成本保持零。
- 例（仅逻辑 fixture，不是生产价格）：成本 `0.0004 + 0.0004 USD`，兑换 `1000`、倍率 `1.5`，最终 `ceil(1.2)=2`。逐项进位结果虽此例相同，须另测三个 `0.0001 USD`：聚合 `ceil(0.45)=1`，不能逐项得到 3。倍率中途变 2 不改变旧 run。

## 4. 预算和预留

每张 run 一次原子预留 R，并冻结用户可理解的最高积分/成本预算、最大调用数（含工具/整理）、每调用输出/输入容量与总截止时间。服务端选择的上界不得超过本次批准预算。预算增加需要新的明确确认，本批不实现动态自动扩额；预算不足拒绝下一次 dispatch，不换模型、不另开 run 绕过。

在同一 run 锁下领取 call 的预算份额。并发已领取/已发出的调用按其最坏上界占用，不能因尚无收据视作零；已关闭调用可按官方最终成本释放预算空间。任意时刻 `已确认成本 + 未决调用最坏上界 + 新调用上界 ≤ run 成本上限`，兑换后不超过 R 和积分上限；无法建立可信最坏上界的配置不可开始收费调用。SDK 自动重试、fallback、隐藏搜索或未纳入的工具费用必须禁用或纳入相同边界。

`maxPreDeduct` 是限制，不是截断后仍放行的理由。余额错误 fail closed；available credits 以原子预扣和 REFUND-1B quarantine 判断为准，不信 UI 缓存。多个 run 同时争用余额也不能超留或负数。

若已发出调用的官方成本异常超过冻结上界：停止后续 dispatch，保存完整真实成本并进入 budget conflict 核对，不静默 Math.min 截成“精准已结算”，不自动超额补扣。用户最高批准额不可突破；该异常的核销/平台承担差额按既有人工授权处理，本批不增设自动亏损政策。

## 5. 唯一钱路、事务和幂等

### 5.1 事务边界与流水兼容

复用 `profiles.credits`、`credit_transactions`、`billing_history` 及原来源分配，不用 run 表保存另一份可花余额。新 RPC 用 SEC-1 service-role-only 权限、固定 search_path、内部 actor/scope 校验；anon/authenticated 无直接写、跨用户读写拒绝。缺 RPC 即失败，不进入 `ALLOW_NON_ATOMIC_BILLING_FALLBACK`。

当前底层 atomic_pre_deduct 改余额/原期计数并写 billing_history，但未同时写 credit_transactions 的预留流水；现有切片在 settle 才补 spend。长时间 unknown 会让单纯的“余额=消费流水和”解释不足，第一批必须在同一既有流水上闭合新 run 的每个已提交余额变化：

1. prepare 事务调用原预扣，关联 run，同时写 `-R` 非消费预留流水（显式 adjustment/专用 reason/source/idempotency metadata，counts_as_spend=false）；禁止对同预扣重复插入。
2. 最终正常结算复用 `atomic_settle` 的来源/恢复计算，在外层同一事务写 `+R` 非消费释放与 `-C` 唯一 spend；两行净额等于实际余额差额，账单只显示 run 消费 C。不能再调用会写第二份消费的 success finalizer。
3. REFUND-1B 拦截时使用原 RPC 的实际恢复 D。为保持金额守恒，非消费释放记 `D+C`，spend 记 `-C`，净额 D；同时保留名义 R、实际释放和被拦截差额，不能把失效订阅份额返成可用积分。确认故障全退的 spend 为 0，释放仅为原 RPC 实际恢复额，订阅已退款份额不复活。
4. 同一事务保存每条流水 balance_before/after 连续快照及唯一键，不能让释放行被当成赠送/推荐返利，子调用不能 counts_as_spend。正常例：B=100、R=20、C=7，prepare 后余额与流水都为80，终结后都为93且累计消费7；故障全退恢复100；unknown 保持80且显示预留20。

以上新增流水只适用于带新 contract_version 的 run，旧预扣不能被再次补预留；旧终态不回算。旧在途调用继续旧 finalizer/recovery，并在现有对账诊断中区分其暂时预留与新 run。不得将历史例外默默忽略、用全量调整抹平差异，或声称 legacy 未决模式已因此修复。实施时用当前 [对账代码](../../../packages/api/src/services/billingReconciliation.ts) 验证新 run 在 prepared/unknown/终态均不产生重复消费或新的余额缺口。

### 5.2 最终事务

使用一致锁序：run → 该 run 的 call/receipt（固定顺序）→ profile → 原绑定 grant。旧路径 profile→grant 顺序不变；禁止 profile/grant 持锁后回头锁 run。receipt 插入、取消与 finalizer 也先取 run 锁。

在一次 PostgreSQL 事务内：

1. 校验 actor/run/合同版本及终态；已终结同请求返回原结果，不追加行；不同终结意图返回已胜出状态或冲突。
2. 封闭调用集合，禁止新 dispatch；验证每个已发出调用的结果和完整权威收据覆盖（确认故障全退见 §6 例外）。
3. SQL 内重算精确成本与 C、验证冻结预算；拒绝客户端传入的最终积分；锁 profile/grant，并按原预扣来源结算或恢复。
4. 同事务写余额差额、既有流水/历史、run 级消费、token_stats/ai_usage_logs 的去重投影、结果关联及 run 终态；任何一步失败全部回滚。结果正文可以先持久化，但未结算不能标财务成功。
5. 保留 `billing_history_terminal_pre_deduct_unique` 的 settle/refund/abort_settle 互斥；新增 run/pre_deduct、actor/request、call/sequence、provider/account/ID、投影/流水幂等唯一约束。唯一约束冲突必须返回原身份或拒绝，不替换成另一笔。

子调用用量保存为证据，run 才有一次收费总计；不得在 token_stats/ai_usage_logs 同时给总行和每子行重复 total_credits/成本。实现可用总行加无收费子投影，旧接口仍能查本用户消费、分页和权限。推荐返利等既有下游只消费幂等 run spend 一次，故障退款/预留/释放不触发。不要用应用层连续三次 RPC 冒充一个事务。

## 6. 终结、取消和 unknown 恢复

调用状态与 run 财务终态分开：单次 responded 不代表成本已完整，更不代表整个 run 成功。run 可为 prepared/dispatched/cost_pending/unknown，财务终态只有 settled/refunded；用户取消记 outcome/cancel_requested，不能和另一终态同时生效。

| 情形 | 必须行为 |
| --- | --- |
| 证明所有调用都未 dispatch | 在同锁下撤销派发令牌并退款一次；迟到旧进程不能再 dispatch |
| 正常可用结果且全部官方收据完整 | 聚合一次结算；多调用/并发回执不提前终结尚未封闭的 run |
| 用户在 dispatch 后取消 | 停止后续调用，保留原输入/已发调用；成本确认后按真实成本一次结算、释放余额。取消不等于确认供应商取消成功 |
| Fusion 部分模型失败但有可用综合结果 | 按官方总成本结算，展示实际状态；不自行扣除未知失败子项 |
| 可确认 Graylum/provider 故障未交付可用结果 | 用户消费为0，按原来源保护全额撤销本操作收费；平台承担已发生成本。只有交付失败证据明确且所有派发权限已封闭才可退款；成本尚缺可保留独立 provider-cost-pending 证据，迟到成本仅平台核对，不再扣用户 |
| 结果未知、传输超时/断线/进程丢失 | 保留 unknown 与原预留，不推定失败，不自动退款、不重发、不二次预扣 |
| 已有可靠持久 provider ID，缺最终成本 | cost_pending；只用经验证的官方按 ID 查询，有次数/时间预算；查无或查询超时不等于零成本 |
| 无 provider ID 或 ID 返回但落库结果不明 | 先读回原 local call；未找到 ID 时 unknown。只有经证实的 provider 客户端关联查询能力才能补取，不能用 local UUID/时间近似匹配或随意枚举账户记录 |
| 有 ID 但无可靠查询能力 | 保留 cost_pending/unknown 与证据，停止自动恢复、现有诊断入口提示人工核对，不承诺查询一定可恢复 |
| 迟到回执与取消/退款/settle 竞争 | 同 run 锁/唯一约束决定一次终态。非终态时去重并按原 outcome 恢复；终态后仅附加成本证据/冲突记录，绝不把 refunded 翻成 settled 或再次扣款 |

确认故障全退与“结果未知”必须有不同判定。仅 HTTP 500、超时或暂时无记录都不足以证明失败/未计费。终态未明确时停止自动核对后仍保留原预留，不能 TTL 退款或自动关闭。人工补偿/核销/退款属于已有授权边界，不在本规格授权；处理后保留原记录和关联，不覆盖历史。

finalize RPC 超时先查原 run/预扣/终态：已提交返回原结果，确实回滚后允许同幂等身份重新提交本地事务。数据库恢复不 dispatch provider。即使获取 ID 成功但落库失败，也不得以重新调用模型来“找回”ID。

## 7. 兼容、迁移和回退

- 在 `packages/db/migrations/` 实际实施时按 live 最新编号分配；不修改已应用 SQL。新增表/可空列/窄 RPC 和索引，保持已有 atomic_* 签名、返回及旧调用前提，重用当前权限模型；禁止 schema push 绕过迁移。
- 每个新请求固定 contract_version，旧运行单/聊天/切片留在原钱路版本。一个 local call 或预扣不得同时交给旧 finalizer 和新聚合 finalizer；新 run 只允许新 RPC 消费其关联预扣，旧入口必须拒绝新 run 身份。切换限新请求，历史账单保留原价格/显示语义，不能称其为 provider-authoritative。
- 第一本地实现交付账务服务与窄 adapter/测试入口；现有公共 chat、slice、research 不整体切流。第二批逐调用方接入，仍在用的旧路由/上下文/清理代码保留，最后阶段才删除。
- 兼容验证覆盖新代码+新库、旧 staging/main 代码+新库、切回旧代码+新库，以及新旧在途请求并存。停新 admission 后回退，保留新表、receipt、调用/预留和结果关联；旧代码不支持新恢复时，保留受控兼容恢复路径或未决诊断，不能交给旧 finalizer 猜测终结。
- 迁移重复执行不丢数据/重扣，失败回滚可重做；字段收缩和历史清理另批。用户/法律删除与最小财务证据保留按既有规则，不因本批无限保存私有正文；未决恢复引用按权限受限。

## 8. 测试分层与交付出口

本节均为未来实施必须运行的验收；当前文档检查不能报告这些已经 PASS。

### A. 本地纯逻辑/adapter 测试

复用 [billing 测试](../../../packages/api/src/services/__tests__/billing.test.ts)、[providerUsage](../../../packages/api/src/services/providerUsage.ts)、[SDK runner 测试](../../../packages/api/src/services/agentSlice/runner.test.ts)。覆盖：两种 scope 与 payload 冲突；精确字符串解析、超精度/非有限/整数溢出、冻结倍率、聚合一次进位；普通/Fusion 覆盖组及工具包含关系；零与缺失成本；重复/冲突/更正回执；预算/调用上限；各取消/unknown 转移。provider HTTP fixture 必须计数，并证明无自动重试。mock 测试不能证明 SQL 原子性。

### B. 隔离 PostgreSQL/RPC、并发与故障测试

复用 [billing-fixture.mjs](../../../packages/db/tests/v3/billing-fixture.mjs)、[run-workbench.mjs](../../../packages/db/tests/v3/run-workbench.mjs)、[run-chat-reliability.mjs](../../../packages/db/tests/v3/run-chat-reliability.mjs)、[run-consumption-protection.mjs](../../../packages/db/tests/v3/run-consumption-protection.mjs) 的一次性 SQL/Auth/PostgREST/本地 provider 基础。fixture 目前只摘录部分迁移函数，新增验证必须包含实际完整前向迁移、约束、触发器与 grants；不能以手写 mock SQL 替代实际 RPC。全部使用隔离测试身份与虚构余额，不加载远端 env，网络拒绝非 loopback provider 调用。

| 必测集合 | 可观测断言 |
| --- | --- |
| admission/prepare | 两 scope 成功；缺 actor、跨用户、父子不匹配、非法 session、撤权、规则缺失均拒绝；失败 provider count=0，无预扣；并发同 request 只一 run/预扣，异负载冲突 |
| dispatch 窗口 | 身份持久失败、claim 提交响应丢失、claim 后发出前崩溃、provider 接受但无 ID、ID 返回落库失败；原预留/input 不丢，不重发；prepared 恢复与旧令牌 dispatch 竞争至多一方成功 |
| 金额/收据 | 普通多调用、Fusion 总项/子项、跨 run 重用 generation、缺失/重复/冲突/迟到收据，结果先保存后结算；未封闭集合不能终结 |
| 预算/并发余额 | 两 run 争最后余额、同 run 多 call 抢预算/序号、隐藏工具/自动 retry、输出上限、超额实报隔离；无负余额/超额调用，未知调用仍占上界 |
| 事务故障 | 在余额、流水、billing_history、usage、结果关联、run 终态写入各点注入 SQL 异常，任何点失败整笔回滚；故障解除同 ID 恢复一次，provider count 不增 |
| 终态竞争 | 多连接同步并发 settle/settle、settle/cancel、settle/refund、refund/迟到回执、unknown/recover；最终只有一个终态/一笔消费，无双退款，重复读回原结果 |
| 来源与对账 | 复跑 REFUND-1B 跨期/当期封顶/逆分配/reversed/termination/quarantine；新 run prepared/unknown/settled/refunded 的余额与流水守恒、消费一次，年度发放/Stripe退款既有语义不变；真实恢复额不复活已退订阅份额 |
| 权限/兼容 | anon/authenticated 直调与跨用户访问拒绝；私有收据不出公开接口；旧历史/分页/消费呈现、新旧钱路并存不双写；正向迁移两次、旧代码+新 schema 与代码回退后未决证据恢复 |

并发必须用不同 PostgreSQL backend PID、同步屏障/锁等待证明真实重叠；保存事务前后行数、余额、原期计数、流水和 provider 计数及故障位置。单连接串行 Promise 或 RPC mock 的“成功”不能判原子性通过。记录可复现命令、精确候选、环境版本、PASS/FAIL/SKIPPED/NOT_RUN。

### C. 后续独立授权的供应商真实对账

第一批不运行收费调用，不建立新 key/供应商配置；真实对账为 **NOT_RUN**，不阻塞本批隔离实现的如实交付，但阻止宣称供应商精确收费已验证或生产启用。第二批接入普通调用、阶段 6 接入 Fusion 时分别取得最小额度及范围授权，按[架构 §11.7](V3-OPC-growth-agent-architecture.md#117-真实验证)核验响应 cost、generation total cost、Graylum 收据/流水与同一供应商账户实际变化。需区分同时发生的账户活动、费用币种及结算延迟，不能拿账户净变动近似值替代单请求证明。

覆盖普通/多调用/Fusion、流式/非流式、搜索/无搜索、取消/部分失败/断流及重复恢复。实际证明 ID、最终成本、覆盖关系、是否可查询；无 ID 的可靠关联能力未验证就保留 unknown，不发明供应商幂等。任何缺项保留 BLOCKED/NOT_RUN，不能借测试之名越过真实费用授权。

### 本任务未来候选 clean 条件

范围内代码/前向迁移、A/B 验收及相关原钱路回归、全部 required CI/Security、独立完整 base-to-head Codex 审查均通过，无可操作阻塞；交付稳定版本接口、兼容/回退证据与 C 层明确限制。第一批合并并不开放供应商生产收费、不完成 V3-M3，也不自动选择第二批。当前文档 PR 只验规格/链接/一致性及其 required checks/独立审查。
