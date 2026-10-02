# DATA-ERASURE：注销期间在途执行与运行单收尾方案

状态：仅方案，等待总控审阅；风险 **high**（封闭账号权限、账务、受限数据库函数）。
本 PR 只增加本文，不实施、不合并、不修改 staging 数据、不访问生产数据库、不调用模型。
原问题运行单在本方案阶段保留不动。按 Owner 决定，**批准合并本修复，就包括对已遗留运行单执行同一机制**；
指未来实施修复的合并批准，不是批准本文或本次推送即允许改数据。部署前总控须再做只读快照，
无需为同一机制再逐笔索取恢复授权；不包含核销、强制退款、改测试窗口或预算。

## 1. 结论与证据边界

推荐：注销立即封闭新的业务执行；已发送调用继续接收最小财务证据，使用原 BILL2
恢复、取消及结算函数收尾；宿主丢失时由已有账务对账入口补偿执行。
不等待用户再次登录，不把注销当作零成本或确认故障。

这里有两个独立缺口：

1. **晚到回执仍依赖用户 Auth。** 宿主每次 BILL2 RPC 都经 `runtimeActor` 重新验证原用户。
   注销会封禁 Auth；provider 返回后认证复用失效，回执可能在进入 B2a SQL 前被拒绝。
2. **没有独立于用户请求的恢复调用方。** B2a 遇到 `accountClosed` 主动停止 Runtime，
   SQL 能收尾不代表有人调用。确认注销只标记 profile/request 并封禁 Auth，不关闭 run。

现场事实来自[总控只读审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/550#issuecomment-5955366273)：
一个注销账号的 execution 仍 running，session 仍有 active_execution；run 未关闭、未请求取消；
唯一 call 已 dispatched 而没有回执，预留仍占用 staging 测试窗口。
本文不复制账号、执行、调用标识或金额。作者未重新连接 staging 数据库。

**可以证实结构性断点，不能凭静态代码认定这一次确切异常。** 无回执也可能来自宿主中止、
数据库故障或持久化预算耗尽；原审计未提供完整事件链，不能声称已证明发生 Auth 拒绝。
[总控补充快照](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5955942588)
记录于 2026-10-02 15:44:01 UTC：仍 running、run 未关闭、零回执、没有供应商生成 ID、
provider_cost_usd 未知，存在 v1 run 级预扣。此为总控提供的证据，作者未重新查询数据库。
这笔大概率只能关闭调用集合并标为费用未知；`cost_pending` 不会因此消失。
0108 的预算守卫对 closed=true 但 provider_cost_usd 为空的 run 仍按 budget_usd 计入，
所以修复**不会释放原 v2 测试窗口的预算占用**。staging 测试已改用 v3 窗口，
不需要本任务调整窗口。测试窗口 v2/v3 与下文 BILL2 合同 v1/PAYG v2 是不同版本概念。
部署前由总控再取一次只读快照，对照错误码/时序、生成 ID、回执数、deadline、绑定和状态，
保留前后证据；缺字段标为缺失，不以这次快照代替部署前复核。
后续经授权只读核验应只取原事件的错误码/时序、provider_id 是否存在、deadline、恢复次数、
回执数量和绑定完整性，不读取业务正文，不通过重新生成来复现原账。

## 2. 当前代码实际做了什么

核验基线：staging `d7011b7bf4e13a2f68ab9294b4ee966550195fef`。
已读取该基线 AGENTS.md、ENGINEERING.md、DATA-ERASURE §3，
[#544 的 B2 方案](https://github.com/Crnobog9527/GraylumAI_vercel/pull/544)及
[#550](https://github.com/Crnobog9527/GraylumAI_vercel/pull/550)。
#550 实际已合并：head `4a746a83143bf89b566b74bedb3997ff7b40fb9a`，
merge `7b880fc4e53766b0af9eb4cd362cd50ffcbebfc0`；其描述中的旧 draft 状态不是当前事实。
代码核验不等于确认远程迁移定义或部署版本。

以下路径均相对仓库根目录；可用上述固定 SHA 回读，避免随主分支漂移。

| 环节 | 来源 | 行为及缺口 |
| --- | --- | --- |
| 确认注销 | `services/accountErasure/service.ts`；迁移 0147、0151 | SQL 写 deleted 和注销请求；事务后 Auth ban；无逐 run 取消/恢复调用。服务路径均位于 `packages/api/src/` |
| 迟到回执 | `services/bill2/service.ts` 的 rpc、dispatchOnce | `await actor()` 在 admin RPC 前；record 失败只返回内存 pendingReceipt。SQL 的注销例外无法处理根本没进 RPC 的请求 |
| Auth 再验证 | `services/runtime/actor.ts`、`authReuse.ts`、budget 传输 | 每次调用验证原 JWT；provider 完成或复用期限结束后重新访问 Auth。不能靠延长缓存解决权限边界 |
| 执行器 | `services/runtime/execute.ts` | accountClosed 后返回 pending；pendingReceipt 检查也经同一 actor；末尾 fail/interrupt 错误被捕获，可能保留 running |
| B2a | `packages/db/migrations/0156_erasure_b2a.sql` | record/close 在锁内识别注销并投影；financial_recovery 支持注销后原绑定结算，不读回正文、不增加派发 |
| 金额终结 | 迁移 0105 的 cancel/pending_calls/recovery_claim；0157 的 finalize | cancel 关闭调用集合并撤销 prepared token；finalize 必须 closed，已发送但缺费用或有冲突则不结清 |
| 现有自动入口 | `apps/web/src/app/api/cron/billing-reconcile/route.ts`、`apps/web/vercel.json` | 每日 04:00 UTC、60 秒宿主上限；目前调用对账和 readiness audit，未调用已注销账号的 Runtime 恢复 |

### 2.1 恢复入口的实际触发条件

- `executeOriginalExecution`（executionStream.ts）正常需要受保护路由和用户 Auth。
  当 `loadStagingPolicy` 失败时，读取原 run 的 recovery policy，构造仅 lookup 的 adapter，
  再调用 `recoverFinancial`。停用宿主时还尝试 runtime_cancel。窗口失效可以触发此分支，
  **但它不是后台任务，也没有免除用户认证**。
- `execute()` 先调用 `runtime_execution(begin)`；之后才处理 cancelRequested，或
  `state=cost_pending && result` 的已有结果恢复。注销后 begin 的账号校验拒绝，不能依赖这两个分支。
- `recoverFinancial()` 是可信维护方法：先 `runtime_financial_recovery(finish=false)`，
  再 `recoverReceipts`，最后 `finish=true`。调用者必须给出可信原 actor；当前网页宿主仍给它
  `runtimeActor`，不是一个独立的财务身份。原 SQL 的权限不要求用户重新登录。
- 0156 先验证 actor/execution/session/run 和预扣绑定；注销例外要求 profile deleted、
  is_deleted=true、真实注销请求及原主体 pre_deduct 同时成立。
  非注销账号保留原 `RUNTIME_EXECUTION_STILL_ALLOWED` 门槛；普通封禁不是注销例外。
- `bill2_recovery_claim` 仅在已派发、有持久化 provider_id、缺已选定费用、lookupSupported、
  无 run conflict、尝试少于 3 次，且不晚于**原 run deadline 后 24 小时**时领取。
  查询预算不足不领取；查询失败不等于零成本。次数和期限不会因注销重新起算。
- `finish=true` 保留已胜出的 delivered/confirmed_failure 等事实；无已有结果则 cancel。
  finalize 成功才把 execution 置 completed/cancelled，并条件清除 active_execution。
  未结清则 execution=cost_pending，目前仍保留 active_execution。

### 2.2 原测试为什么没发现

`services/runtime/streaming.integration.ts` 的 B2a 用例注入 `actor: async () => f.actorId`，
并在测试中显式调用 recoverFinancial。它证明 SQL 投影和手动维护有效，但绕过真实 Auth ban，
也替产品补上了不存在的后台触发。新增回归必须覆盖真正的宿主认证链及无人回访场景。

## 3. 建议修复：最小财务收尾通道

### 3.1 拆开业务权限与已发生调用的持久化权限

保留业务准入、prepare/claim/dispatch、Runtime 正文读写现有认证，不放宽 `runtimeActor`，
不把普通 runtimeExecutor 全部换成固定 actor。
在已验证准入且取得原 call 的可信宿主闭包中，保留原 actor/execution/run/call 的绑定，
仅给回执记录、既有财务回读、取消/结算提供内部能力；不接受客户端提供的 actor、价格或回执。
**宿主内适用于所有已获授权且已经派发的调用**：正常账号、调用途中退出登录、改密码导致
会话撤销、管理员禁用/封禁、注销，均不再以当前 getUser 成功作为原回执记录和财务结算的条件。
这只承接当时已获授权的原 call；不授予下一次调用权，不恢复任何用户访问权限。
退出登录或改密码后的 profile 通常仍 active；管理员 `updateUserStatus` 只改 profiles.status，
并不封禁 Auth。不能据此声称 disabled/banned 的 record/close/finalize 被 SQL active 门槛拦住。
按本轮静态核验及总控更正，**新增窄分支仅限两处非注销路径**：

- `bill2_read`（0156:133–134）：disabled/banned 的原 actor/run 下存在已派发 call 时，
  允许读取必要财务视图，不读取 private_input 或 SDK 正文。
- `bill2_revoke_unstarted_dispatch`（0156:334–335）：对已取得派发许可并登记派发事实、
  绑定原 actor/run/call 的调用，允许原 token/hash 撤权证明，包括 `p_inspect` 和幂等回读。
  “已派发”在这里是数据库派发许可事实，不等于 HTTP 已实际开始；只有原可信传输证明未开始
  才能撤权，不能用零回执代替。撤权后保留的 dispatch_granted_at/dispatch_revoked_at
  用于识别同一原证明并回读，不能因为 dispatched_at 已清空而破坏幂等。

两处均保留原归属、scope、预扣、合同版本、金额/来源、冲突与撤权资格约束；
不以任意已派发 call 授权另一笔账。v1/run 与 v2/call 预扣按 §3.6 分别核验。
**不修改或放宽 bill2_actor 本身**；prepare、claim、dispatch、bill2_private_input、
正文类 RPC 仍拒绝 disabled/banned。注销账号继续原 B2a 路径，不改注销判定。

以下函数目前没有 active 门槛，**本修复也不新增**：`bill2_record`、`bill2_close`、
`bill2_cancel`、`bill2_finalize`、`bill2_pending_calls`、`bill2_recovery_claim`、
`runtime_receipt_saved`、`runtime_financial_recovery`。它们列为 disabled/banned 的行为回归，
不是“实际走新增窄分支”的测试对象。record 仍保留其已有 dispatched_at 要求；
尤其不得给 close/cancel/finalize 加“必须有已派发事实”，只有未派发 call 的 run
仍可 cancel+finalize 释放一次预扣。financial_recovery 保留已有绑定与恢复资格判断；
runtime_history_available 对禁用账号捕获权限异常返回 false，不需新增 active 豁免。
SQL 能执行不等于无条件成功：原证据、绑定、查询次数/截止等约束继续生效。

**后台批次只处理已注销账号**：由 service-only 数据库读取真实注销请求及原绑定构造能力，
不依赖用户 JWT；普通退出、改密码、disabled/banned 但无注销请求的遗留 run 不纳入本批次。
它们的跨进程补偿不在本次范围内，不能把宿主内允许误写成后台也允许。

这个能力不能调用模型、创建运行单、追加预扣、复活 token 或读取 SDK 正文。
继续使用 B2a SQL 的锁内注销判定和财务白名单；回执响应丢失先查原身份与证据 hash，
确认缺失后才幂等补记。不能借 `runtime_receipt_saved` 的用户认证路径再次卡住：
优先用已有财务回读；确需精确查 hash 时只扩展同一窄财务读取，不放宽 Runtime 正文读取。

### 3.2 先保存供应商身份，后等待最终费用

复用官方 adapter 和 `bill2_record`。在官方响应头或通过身份校验的首个 SSE frame
首次出现可靠 generation ID 时，尽早写一次无正文 transport_observation（final=false、无 cost），
并沿原 run/call/provider/account/model 绑定去重。此后最终回执仍按原解析、精确金额和冲突规则处理。
不能把原始 SSE/压缩正文当作财务观测；后续 ID/模型矛盾须追加冲突事实，不能覆盖先前记录。
ID 早记不得阻塞流式输出：在同一请求内启动一次有界写入，读取和转发下一帧不 await 该写入；
失败不抛回流式读取循环，不中断输出，最终持久化阶段在剩余预算内等候并核对/幂等补记。
不使用请求结束后无人持有的悬空任务，不引入后台队列；早记与最终回执并发沿原 run 锁及去重处理。
在模拟慢写/写失败下对比修改前后的首字时间和帧间隔，不能用先等数据库再发送首字的实现。

当前 adapter 在读取整个响应后才交回 observation，generation ID 只在内存，进程消失会丢失。
提前记录缩小这个窗口，但**不能保证消除发出请求到取得 ID 之间的未知**。
没有官方 ID 时不按本地 requestId 猜查，不重发原请求；最终只能报告缺证，而不是编造费用。
已有未知运行单是否能补费用，取决于受控证据中是否有可靠原 ID；本 PR 不向供应商查询。

### 3.3 注销时的状态规则

确认事务保持原 profile 锁顺序；先提交封闭标记，再在独立事务按原 Runtime/BILL2 锁序处理。
不在持有 profile 锁时循环等待 run，也不把网络查询放进注销数据库事务。

| 已有事实 | 处理 | 账务结果 |
| --- | --- | --- |
| 未派发 prepared | 原 cancel 撤销 token，financial_recovery 收尾 | 原预扣一次恢复，无新扣款 |
| PAYG waiting_credits 遇到注销 | 撤销继续资格/epoch，关闭调用集合，仅当 active_execution 仍指向本执行时清除；不等充值、不自动 resume | 已结算前缀不变；未派发 hold 一次释放；已发送未知 call 保留各自 hold，转 cost_pending；零 call/零 hold 无伪造退款流水 |
| 已获派发许可但可靠证明未开始 HTTP | 复用 0137/0156 的原 token/hash 撤权证明 | 撤权成功后一次恢复；不能用“零回执”代替证明 |
| 已发送、最终费用可靠 | 原 call record；financial_recovery 取消后续执行并 finalize | 按冻结规则结算一次，释放差額，仅当 active_execution 仍指向本执行时清除 |
| 已发送、有 ID、费用未定 | 关闭调用集合，execution=cost_pending，受限 lookup | 成本未知保持原预留；结果明确后 finalize |
| 无 ID、查询耗尽/过期、冲突或原凭据不可用 | 关闭调用集合，登记 billing_pending 与明确原因，升级人工核对 | 不自动退款、不伪造 settled；按 §3.5 管理到有依据的处理决定 |
| 已有胜出交付或确认故障、已 settled/refunded | 尊重原 outcome/终态，补齐 execution/session | 不翻转终态；确认故障退款后晚到费用只记平台成本，不再扣用户 |

建议在注销后的 `cost_pending` 分支也用 `WHERE active_execution=原 execution` 条件清除活动指针，
明确它已停止业务运行；保留 execution/session_ref/run 的原绑定供财务恢复，不能物理删 session。
这是拟追加迁移对 0156 恢复函数的最小变更，不能直接 UPDATE 现场数据或改历史迁移。
B1b 正文擦除仍在单独事务通过原屏障；本切片不扩为 B2b 全量脱敏或 PR-C 全部物理删除。

### 3.4 无用户回访也能推进：cron 主要关闭和上报

费用证据主要靠宿主内两条路径：①尽早保存可靠 ID，在本次请求预算和原查询限制内按 ID 补查；
②直接持久化晚到最终回执，或对已得到但写入结果不明的回执先查后补。早记 ID 本身不是费用。
复用两种收尾触发：注销提交后尝试一次有界纯数据库收尾；晚到回执记录成功后尝试同一收尾。
二者失败都不撤销注销、不重发模型，原持久化注销请求就是补偿入口。
再在**已有 billing-reconcile cron** 中加入一个独立、有预算上限的恢复批次，保持已有对账检查。
不增加 cron 注册、队列、worker 服务、任务表或持久化状态机。

批次只枚举确有注销请求且仍有非终态 BILL2/Runtime 的原绑定，兼顾 closed=true 的未决 run，
以及 run 已终态但 execution/active_execution 未同步的行，不能只筛 closed=false。
先做短事务关闭集合；活动指针只在仍指向本执行时释放，再在事务外做有界 lookup，最后执行原 finish；
单项失败继续其他合格项，下一次从数据库事实恢复。
当前 recoverFinancial 将 lookup 失败与 finish 串联，拟让非致命查询失败也能独立完成关单阶段，
但绑定/权限失败必须停止该项，不能用 finally 无条件绕过。

cron 每日 04:00 UTC 运行，宿主 maxDuration=60 秒，单次 lookup 最坏超时为 45 秒。
与既有对账/readiness 共用预算后，**按每天 0–1 次最坏耗时查询规划**，不是每笔每天一次；
余量不足就零次。快速查询可能完成更多，但不能把它作为吞吐或恢复保证。
v1 原 deadline+24h 内通常只有一次每日任务机会，也可能错过；PAYG v2 则按每个 call
冻结的 recovery_deadline（本 call 截止+24h）及最多 3 次查询，已派发后不延长。
因此 cron 的主要职责是批量纯数据库关闭和上报，lookup 仅为预算允许时的补漏。
验收实测单次运行的关单数、查询数、耗时、剩余未决数及最老年龄，不能声称“每天三次查询”。

批次需在 60 秒宿主预算内为既有对账和持久化留余量，使用现有 lookup timeout/budget，
不足时停止领取；以注销请求已有 stage_updated_at/retry_count 做有限轮转，按稳定 run ID 分页，
不让一笔缺 ID 账单长期饿死其他项。失败/未决数量和最老未处理时间进入原对账报告，不能报全成功。
每日入口并不保证在对应合同的截止窗口内拿到三次查询机会；宿主内证据保存/恢复优先，
错过窗口就升级未决，**不延长原期限、不为完成三次而密集循环或新增调度器**。
部署是否实际启用此 cron 必须在未来获准的 staging 验收中证明；配置文件本身不是运行证据。

### 3.5 开放运行单与长期未知的验收边界

`closed=true` 只表示不再增加调用，不等于财务 settled/refunded。
本方案保证已有执行不再假装 running、开放调用集合被关闭、未决账进入独立维护；
**不能在缺少供应商证据时保证实际费用必定恢复，也不能承诺全部财务账单自动终结。**
这与 DATA-ERASURE §3.2 的禁止未知退款规则一致。

无 ID/过期/冲突等项必须在既有注销阶段记 billing_pending 和枚举错误码，列入受控对账清单，
记录核对结论、责任归属及下次复核日期；沿现有任务/审计记录保存，不新建系统。
`T_review` 的 30 天建议是人工复核节奏，不是自动退款或结清期限；每日报告不能代替实际跟进。
终结依据只有：可信最终成本后原 finalize；可靠确认故障后原退款；或 Owner 逐笔批准的
补偿/核销方案。最后一种另行设计记账方式和审批，不能伪造 confirmed_failure、直接改余额或旧流水。
若总控要求“即使永久缺证也必须在固定日期财务终态”，那是新增资金政策，当前方案不暗中采用。

### 3.6 BILL-PAYG v1/v2 兼容：双方必做、必测

0156:20–26 的 `bill2_erasure_closed(a, pre)` 目前只认 run.pre_deduct_id。
PAYG v2 将预扣移到 call，run.pre_deduct_id 为空；不能沿用该判断，也不能仅凭 pre 为空判定注销。
由 #553 的计费核心 PR-A 负责引入合同感知的注销判定和全部调用点适配：

- 共同要求真实注销请求、deleted/is_deleted、actor 与原 execution/session/run 绑定一致。
- v1 继续校验 run 级 pre_deduct 属于原 actor，不改变历史合同与查询期限。
- v2 按原 run 的合同版本及归属检查每个已有 call 的预扣：call 属于该 run、pre_deduct 属于
  同一 actor，沿唯一关联和原金额/来源约束核验；拒绝跨 run/call/actor 冒用，不能只找任意一笔预扣。
- 合法零 call/零 hold 的 v2 waiting_credits 仍须能关闭：凭合同/注销/原绑定证明身份，
  不创建占位预扣。已有应具预扣的 call 缺失或错绑则报绑定异常，不能套用零 call 例外。
- 同步 bill2_read/record/close、runtime_financial_recovery 及其 helper 调用；按需要最小调整
  helper 签名以接收原 run 身份，不修改已应用的 0156 文件、不复制一套注销/资金权威。
- waiting_credits 由 #553 Runtime PR-B 接线：注销后禁止充值续跑，按 §3.3 收尾；
  已结算前缀不重扣，已派发未知 call 各自保留 hold，不重新冻结全 run，也不按 v1 run 预留结算 v2。

双方实施验收都必须覆盖 v1/v2 注销中途、零 call 等待积分、已结算前缀加未知后续、
错绑拒绝、call 查询期限不重置；不能只测默认合同。该要求属于 #598 和 #553 的共同交付条件，
本轮仅修改 #598 文档，不声称已更新 #553 或已实现 PAYG。

### 3.7 合并顺序、单一 writer 与同步责任

推荐实施顺序：#590、#593 先合并；本 #598 对应的 v1 收尾实施 PR 接着合并；
#553 PR-A 再引入 v2 合同兼容，PR-B 接等待积分收尾；v2 默认启用必须在双方兼容用例通过后。
#598 是方案号，未来实施 PR 另建，不把方案合并当功能上线。若实际顺序改变，
后合并方必须先同步最新 staging 和前一方实现，完成全部受影响的 v1/v2 回归及独立结论，
不能覆盖先合并方的注销谓词或恢复逻辑。并行时重叠函数只保留一个 writer，按 PR 记录交接。

| 关联 PR | 适配与同步负责人、验收 |
| --- | --- |
| #553 BILL-PAYG | PR-A writer 负责 v1/v2 预扣绑定及财务 RPC，PR-B writer 负责 waiting_credits；#598 实施 writer 保留 v1 能力并纳入双方兼容验收。后合并方承担最终集成，不能把适配留在无人负责的后续项 |
| #590 门禁 | #598 实施 writer 基于其合并后的 staging，在财务恢复使用 runtimeExecutor 时显式传 callGate: denyNewCalls；stopNewCalls/限流生效时 recovery 仍能 record/close/finalize，任何新 claim 被拒；不省略门禁或传允许新调用的替身 |
| #593 信息捕获 | 同改 executionStream.ts，#598 实施在 #593 合并基础上同步；如顺序倒置由 #593 writer 同步。账号已关闭或结果 pending/cost_pending 时不触发捕获写入；正常 completed 捕获行为保留，测试注销并发与写入前封闭检查 |
| #597 财务报表 | 已合并为 c6441946；由 #598 对应实施 PR（后合并方）负责核对并补齐费用未知 run 的展示，不能将实际费用或名义费用的未知值当 0，也不能把 closed 当 settled；不再交给已结束的 #597 writer |

上一轮快照中 #590/#593 的 head 分别为 9874815e、fd210532；#597 的 555e595d
已先合并为 c6441946，不再是 OPEN；
#553 仍是方案，head 135d4c19。这些是快照，未来开工/合并时重新核对，不按旧号预占迁移。

**邀请返利保持原行为**：SQL `runtime_financial_recovery → bill2_finalize` 不经过 TS
`finalizeRun → applyInvitationRebateForSpend`，因此此恢复路径不触发邀请返利，
包括注销后迟到结算。此次不补发返利；#553 的正常计费下游不能因此重复给恢复账单返利。

## 4. 三年保留与可对账

按 [#553 名义费用决定 5957160656](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553#issuecomment-5957160656)，
PAYG 将同时保留供应商实际费用和名义收费基准；收费公式、冻结标价及计费实现归 #553。
本修复恢复时按原合同和冻结依据处理，不能拿新口径重算 v1 历史账。
报表须区分这两个值：未知不能展示或聚合成 0，也不能用其中一个冒充另一个。
若某一项已有独立可靠证据，可显示该项已知值，同时明确另一项仍未知；两项均缺证则都标未知。
该联调和补齐由 #598 实施 PR 负责，列入 §6 必测，本轮不实施名义计价或修改报表。

沿 DATA-ERASURE 已定要求：从对应交易年度结束起保留三年，不从注销或恢复日期重新计时。
保留原不可登录财务主体、run/call/预扣/流水关系、派发和取消事实、冻结价格、精确费用、
证据来源与查询次数、平台承担费用和未决原因；原证据 hash 与财务投影 hash 分开。
无正文回执仍应能复算钱路；没有金额证据时明确“未知”，不能用 hash 代替原官方金额。

保留三年本身不会让零回执变成可对账。该修复补的是证据持久化和有责任人的恢复路径。
未知费用不能无限保留全账号正文，也不能到三年就连同尚有依赖的主体直接删掉。
到期的具体保全按 DATA-ERASURE §3.3 逐笔记录理由、批准与复核日；本方案不新增统一延长期限。

## 5. AGENTS §5：为何这是最小做法

已考虑：直接调用 execute 会重新要求登录/正文且可能进入业务；仅加 accountClosed 后收尾
覆盖不到写回执前 Auth 失败；只做注销请求内同步收尾覆盖不到进程死亡；新建调度系统没有必要。

复用原 actor/run/call/receipt/预扣权威、B2a 投影、cancel/finalize/recovery_claim、
注销阶段表及现有 cron。最小缺口是**窄财务身份、可靠 ID 早记、持久化事实驱动的补偿调用**。
disabled/banned 的 SQL 改动仅在 bill2_read、bill2_revoke_unstarted_dispatch
两处追加 §3.1 窄分支；其余八个财务函数不新增 active 或已派发门槛，仅做行为回归。
不新增独立结算系统，不扩大新调用准入，不修改注销判定，不改历史迁移。
BILL2 表不向 service_role 开通通用 DML。批次发现与精确回读如现有 RPC 不足，
只新增/扩展一个 service-only 财务枚举读取入口，返回必要绑定、冻结策略和状态；
固定 search_path、限制数量、明确注销谓词，不接受任意 SQL，不返回正文。
阶段写回扩展已有注销进度函数的受限操作，不为批次引入新授权系统。

PAYG 合同兼容复用 #553 的 call 级预扣和版本分支，责任及合并顺序见 §3.6–3.7；
不得用新增 run 级占位预扣“兼容”v2，也不新增独立注销计费账本。

预计实施范围：BILL2 service/adapter、Runtime 财务宿主与恢复、accountErasure 窄触发、
现有 billing-reconcile 接线、一个追加迁移及相关测试/指纹。真正实施前按最新 staging
重新核对相关 writer；不修改其他计价方案、预算提示、测试窗口、旧引擎或生产配置。

## 6. 必测项（本 PR 均未执行功能测试）

| 场景 | 必须证明 |
| --- | --- |
| 真实宿主 Auth 时序 | provider 阻塞期间确认注销并模拟 Auth ban/getUser 拒绝；晚到回执仍只落财务，普通业务仍拒绝；不是固定 actor 替身绕过测试 |
| 无后续用户请求 | 注销触发中断、worker/宿主重启、回执后崩溃；已有 cron 补齐 run/execution/session，并输出失败而非假成功 |
| ID 早记与缺证 | 首个合法 ID 后崩溃仍能原 ID lookup；无 ID 永不猜查/重发；ID 冲突 fail closed；不持久化原始 SSE/正文 |
| 宿主内允许路径 | 已派发后退出登录、改密码撤销会话、disabled/banned、注销均可凭原闭包持久化回执及合法结算；正常账号也测；不依赖 getUser 再成功 |
| disabled/banned 两处窄分支 | 两种状态分别验证原 actor/run 的已派发 call 可经 bill2_read 读取财务视图、经 bill2_revoke_unstarted_dispatch 原 token/hash 执行撤权与 p_inspect；实际走新增分支，跨绑定拒绝，正常 active/注销不变 |
| disabled/banned 既有财务回归 | record、close、cancel、finalize、pending_calls、recovery_claim、runtime_receipt_saved、runtime_financial_recovery 各自满足原条件时照常执行，不新增 active 门槛；已派发 call 可写回执、关单、结算 |
| 未实际发送与释放 | disabled/banned 分别测：只有 prepared 未派发 call 的 run 可 cancel+finalize，预扣仅释放一次；已登记派发许可但可靠证明 HTTP 未开始的 call 可撤权后正常释放；撤权回包丢失用 p_inspect 读回不重复释放；零回执但无证明不能撤权 |
| disabled/banned SQL 拒绝 | 两种状态分别验证新的 prepare、claim、dispatch、private_input、正文类 RPC 均拒绝，包括禁用前 prepared 的新派发；未派发伪回执、跨 actor/run/call 拒绝；bill2_actor 仍要求 active |
| 拒绝与后台边界 | anon/authenticated 直调、伪造/跨 actor/run/call、未派发伪回执拒绝；后台只允许真实注销原绑定，普通禁用无注销请求拒绝；新 prepare/claim/dispatch 和正文权限保持 |
| PAYG 双合同 | v1 run 预扣、v2 call 预扣在注销场景都通过；零 call/零 hold waiting_credits 能终止；已结算前缀+未知后续仅保留后者 hold；缺失/错绑拒绝；不等待充值、不重复扣款 |
| 门禁与捕获 | callGate: denyNewCalls 下恢复通过、新 claim 拒绝；stopNewCalls/限流不拦恢复；已关闭或 pending/cost_pending 不发生 #593 捕获，正常 completed 仍可捕获 |
| 流式延迟 | 同一夹具对比首字时间、帧间隔，注入 ID 写入延迟/失败；首字不等待早记，持续输出不中断，结束前有界核对早记结果 |
| 返利与报表 | SQL 恢复不调用邀请返利、不补发；#598 实施 PR 在已合并 #597 上核对并补齐未知费用 run 展示：实际费用与名义费用分别保留未知，均不当 0、不漏掉；closed=true 不等于 settled/refunded，列表、汇总和导出均测 |
| 状态与并发 | prepared、可靠未发送、dispatched、known/unknown、run 终态而 execution 非终态；注销/record/cancel/finalize 并发，无反锁；仅清原 active_execution |
| 查询限制 | v1 原 run deadline+24h；v2 原 call recovery_deadline；各最多 3 次；无 ID/不支持 lookup/冲突/凭据换绑/预算不足不猜查；不重置次数、不新增 POST/预扣 |
| 金额 | 0157 冻结计价兼容、精确小数、一次取整、来源保护、一次消费/释放；退款后晚到成本只记平台；未知不是零 |
| 模糊写入 | 已提交但回包丢失先读回；去重不依赖用户 Auth；回执与终态重放无二次扣费、无回填正文 |
| 内容与擦除 | 正文/SDK/transport/gzip/Base64 canary 不进入封闭后证据或输出；B1b 屏障、擦除后不可逆、待结清绑定仍可核对 |
| 批次 | 单项失败隔离、并发重复触发、分页不饿死、60 秒预算、已关闭未决也入选；实测关单/查询数及耗时，验证 45 秒 lookup 下每日约 0–1 次预期；原检查不降级、未决年龄可见 |
| 遗留证据样本 | 部署前总控再次只读快照；获准部署后由同一机制处理，无临时改数；无生成 ID 只关单并保持费用未知、原 v2 测试窗口预算不释放，v3 测试窗口不受此修复调整 |
| 保留与回退 | 年底起算三年、具体保全、财务完整性、暂停后重复推进；不能删证据或重新开放账号 |

后续实现必须跑文件建库/迁移重复执行/指纹、B2a SQL 和 BILL2/Runtime 集成、
相关 API/Web/lint/typecheck、安全与全部必需 CI；浏览器用隔离供应商夹具覆盖注销中途场景。
本轮不执行真实 staging 调用、供应商查询或迁移。未来实施批准须明确相应外部执行范围；
按 Owner 已定边界，批准合并本修复包含对已遗留运行单执行同一机制，部署前总控再做只读快照。
不再把该遗留样本列为需要另一次逐笔恢复授权；补偿/核销、真实模型调用和生产仍不在此授权内。

## 7. 回退、交付与停止点

本方案文档回退：关闭 draft 或撤销单文件提交，无运行时/数据影响。
未来实施回退：停止新增财务补偿接线，保留账号封闭和原账务证据，排空在途写入后读回状态；
保留已应用投影/财务列，不反转终态、不恢复已擦正文、不恢复派发 token。
未出现新格式数据时才可按预先验证的旧定义结构回退；已产生新事实优先前向修复。
暂停期间明确报告未决积压，不能重新依赖已注销用户发请求。

本次只读完成方案/代码/审计一致性检查，未执行数据库或供应商操作；功能、并发、回退测试 NOT_RUN。
PR 的 CI 是现有仓库检查，不是缺陷已修复的证据；独立方案结论等待总控。
总控审阅本方案之前不实施。交付 draft、留下“可以审查”后本 writer 停止写入。

## 8. 修订记录

2026-10-02：按[独立审查 5955878568](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5955878568)、
[Owner 分类决定 5955935438](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5955935438)
一次修订原 head 9d078a03；证据补充来自总控快照 5955942588。本轮只改本文。

| 发现 | 本次处理 |
| --- | --- |
| P1 / C 类 | §3.3、3.6–3.7、5–6：v1/v2 注销判定、call 预扣、waiting_credits、#553 PR-A/PR-B 责任、合并顺序及双合同必测 |
| P2-1 / B 类 | 开头、§1、6：未来修复合并批准涵盖遗留 run；部署前再快照；无生成 ID、费用未知、v2 窗口预算不释放，测试已用 v3 |
| P2-2 / C 类 | §3.1、6：所有已派发调用的宿主内财务持久化，后台仅注销账号，分别测试允许与拒绝 |
| P2-3 / B 类 | §3.4、6：宿主两条主要费用证据路径；cron 关闭/上报为主，60 秒与 45 秒约束、每日 0–1 次最坏查询预期及吞吐实测 |
| P3-1 | §3.7、6：#590 denyNewCalls 门禁接入与恢复放行测试 |
| P3-2 | §3.2、6：ID 早记不阻塞输出，慢写/失败及首字时间对比 |
| P3-3 | §3.7、6：SQL 恢复不触发邀请返利，保持现状并验证 |
| P3-4 | §3.7、6：#593 捕获、#597 未知费用展示的重叠及后合并方同步责任 |

验证边界：仅文档静态核对；功能/数据库/供应商/并发/回退测试 NOT_RUN。
原 PR 描述里“原运行单恢复授权缺失”的表述已由本修订及 Owner 决定取代；本轮按单文件范围
不修改 PR 描述或 #553。推送后等待当前 head CI/Security 通过，再留下“可以审查”并停止写入；
这不是新 head 的独立审查通过，也不授权实施代码或现在改 staging 数据。

### 2026-10-03：增量复核剩余项

依据[增量复核 5956304291](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5956304291)
和[总控决定 5956312557](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5956312557)，
从 4c3a4942 修订，只改本文和 PR 描述；上一轮 §8 的“不修改 PR 描述”仅指上一轮边界。

- P2：§3.1、§5、§6 补 disabled/banned 已派发原绑定的 SQL 财务窄分支与允许/拒绝测试；
  prepare/claim/dispatch 仍要求 active，bill2_actor 不变，注销路径不变，后台批次范围不扩大。
- P3：§3.3 的活动指针均明确仅当仍指向本执行时清除，避免误清等待期间产生的新执行。
- P3：PR 描述 Handoff/Blockers 更新为本次 head、修订状态和当前验证；去掉遗留运行单
  需要另取恢复授权的旧说法。#553 的冻结措辞由其 writer 下轮对齐：仅释放未派发冻结，
  已派发但费用未知的 call 保留各自冻结；本轮不修改 #553。

本次仍未实施代码、SQL 或配置，未访问数据库或调用供应商；新增功能验证 NOT_RUN。
CI 通过只说明文档候选通过现有检查；新 head 仍需独立增量结论。交付后停止写入。

### 2026-10-03：更正 SQL 门槛事实与报表责任

依据[增量复核 5956696834](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5956696834)、
[总控确认 5956706024](https://github.com/Crnobog9527/GraylumAI_vercel/pull/598#issuecomment-5956706024)
及 #553 评论 5957160656，从 3ba7a4fe 修订本文与 PR 描述。
上一轮关于 record/close/finalize 有 active 门槛的事实前提有误；上一条修订记录仅保留历史，
不作为实施要求，以本次 §3.1、§5、§6 更正为准。

- P2：窄分支只在 read、revoke_unstarted_dispatch；其余八函数没有 active 门槛且不新增，
  close/cancel/finalize 不加已派发前提。补齐原有行为、未派发取消释放、可靠未发送撤权的回归。
- P3：§3.4 活动指针仅在仍指向本执行时释放。
- #597 已先合并，报表核对/补齐归本方案实施 PR；实际费用与名义费用分别保留未知，
  均不当 0，关单不当结清；列入实施必测。
- 本轮仅静态核对最新 staging 迁移定义及指定决定，未运行功能测试、访问数据库或供应商。
  推送后核对当前 head CI，再同步描述和交付评论；新 head 仍待独立增量结论。
