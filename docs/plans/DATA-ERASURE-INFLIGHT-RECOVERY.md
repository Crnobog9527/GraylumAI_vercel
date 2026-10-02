# DATA-ERASURE：注销期间在途执行与运行单收尾方案

状态：仅方案，等待总控审阅；风险 **high**（封闭账号权限、账务、受限数据库函数）。
本 PR 只增加本文，不实施、不合并、不修改 staging 数据、不访问生产数据库、不调用模型。
原问题运行单保留为证据；本方案不授权对它执行恢复，也不调整测试窗口或预算。

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
数据库故障或持久化预算耗尽；审计未提供 provider_id、原 deadline、Auth 返回码或完整事件链。
不能声称供应商没收费、provider_id 必为空，或已证明发生 Auth 拒绝。
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
后台能力由 service-only 数据库读取的原绑定构造，不依赖用户 JWT。

这个能力不能调用模型、创建运行单、追加预扣、复活 token 或读取 SDK 正文。
继续使用 B2a SQL 的锁内注销判定和财务白名单；回执响应丢失先查原身份与证据 hash，
确认缺失后才幂等补记。不能借 `runtime_receipt_saved` 的用户认证路径再次卡住：
优先用已有财务回读；确需精确查 hash 时只扩展同一窄财务读取，不放宽 Runtime 正文读取。

### 3.2 先保存供应商身份，后等待最终费用

复用官方 adapter 和 `bill2_record`。在官方响应头或通过身份校验的首个 SSE frame
首次出现可靠 generation ID 时，尽早写一次无正文 transport_observation（final=false、无 cost），
并沿原 run/call/provider/account/model 绑定去重。此后最终回执仍按原解析、精确金额和冲突规则处理。
不能把原始 SSE/压缩正文当作财务观测；后续 ID/模型矛盾须追加冲突事实，不能覆盖先前记录。

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
| 已获派发许可但可靠证明未开始 HTTP | 复用 0137/0156 的原 token/hash 撤权证明 | 撤权成功后一次恢复；不能用“零回执”代替证明 |
| 已发送、最终费用可靠 | 原 call record；financial_recovery 取消后续执行并 finalize | 按冻结规则结算一次，释放差額，清 active_execution |
| 已发送、有 ID、费用未定 | 关闭调用集合，execution=cost_pending，受限 lookup | 成本未知保持原预留；结果明确后 finalize |
| 无 ID、查询耗尽/过期、冲突或原凭据不可用 | 关闭调用集合，登记 billing_pending 与明确原因，升级人工核对 | 不自动退款、不伪造 settled；按 §3.5 管理到有依据的处理决定 |
| 已有胜出交付或确认故障、已 settled/refunded | 尊重原 outcome/终态，补齐 execution/session | 不翻转终态；确认故障退款后晚到费用只记平台成本，不再扣用户 |

建议在注销后的 `cost_pending` 分支也用 `WHERE active_execution=原 execution` 条件清除活动指针，
明确它已停止业务运行；保留 execution/session_ref/run 的原绑定供财务恢复，不能物理删 session。
这是拟追加迁移对 0156 恢复函数的最小变更，不能直接 UPDATE 现场数据或改历史迁移。
B1b 正文擦除仍在单独事务通过原屏障；本切片不扩为 B2b 全量脱敏或 PR-C 全部物理删除。

### 3.4 无用户回访也能推进

复用两种触发：注销提交后尝试一次有界纯数据库收尾；晚到回执记录成功后尝试同一收尾。
二者失败都不撤销注销、不重发模型，原持久化注销请求就是补偿入口。
再在**已有 billing-reconcile cron** 中加入一个独立、有预算上限的恢复批次，保持已有对账检查。
不增加 cron 注册、队列、worker 服务、任务表或持久化状态机。

批次只枚举确有注销请求且仍有非终态 BILL2/Runtime 的原绑定，兼顾 closed=true 的未决 run，
以及 run 已终态但 execution/active_execution 未同步的行，不能只筛 closed=false。
先做短事务关闭集合/释放活动指针，再在事务外做有界 lookup，最后执行原 finish；
单项失败继续其他合格项，下一次从数据库事实恢复。
当前 recoverFinancial 将 lookup 失败与 finish 串联，拟让非致命查询失败也能独立完成关单阶段，
但绑定/权限失败必须停止该项，不能用 finally 无条件绕过。

批次需在 60 秒宿主预算内为既有对账和持久化留余量，使用现有 lookup timeout/budget，
不足时停止领取；以注销请求已有 stage_updated_at/retry_count 做有限轮转，按稳定 run ID 分页，
不让一笔缺 ID 账单长期饿死其他项。失败/未决数量和最老未处理时间进入原对账报告，不能报全成功。
每日入口并不保证在原 deadline+24h 内拿到三次查询机会；注销/回执触发优先尝试，
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

## 4. 三年保留与可对账

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
BILL2 表不向 service_role 开通通用 DML。批次发现与精确回读如现有 RPC 不足，
只新增/扩展一个 service-only 财务枚举读取入口，返回必要绑定、冻结策略和状态；
固定 search_path、限制数量、明确注销谓词，不接受任意 SQL，不返回正文。
阶段写回扩展已有注销进度函数的受限操作，不为批次引入新授权系统。

预计实施范围：BILL2 service/adapter、Runtime 财务宿主与恢复、accountErasure 窄触发、
现有 billing-reconcile 接线、一个追加迁移及相关测试/指纹。真正实施前按最新 staging
重新核对相关 writer；不修改其他计价方案、预算提示、测试窗口、旧引擎或生产配置。

## 6. 必测项（本 PR 均未执行功能测试）

| 场景 | 必须证明 |
| --- | --- |
| 真实宿主 Auth 时序 | provider 阻塞期间确认注销并模拟 Auth ban/getUser 拒绝；晚到回执仍只落财务，普通业务仍拒绝；不是固定 actor 替身绕过测试 |
| 无后续用户请求 | 注销触发中断、worker/宿主重启、回执后崩溃；已有 cron 补齐 run/execution/session，并输出失败而非假成功 |
| ID 早记与缺证 | 首个合法 ID 后崩溃仍能原 ID lookup；无 ID 永不猜查/重发；ID 冲突 fail closed；不持久化原始 SSE/正文 |
| 权限 | anon/authenticated、伪造 actor/run/call、普通封禁无注销请求都拒绝；已注销原绑定可财务恢复；不能 prepare/dispatch/恢复正文 |
| 状态与并发 | prepared、可靠未发送、dispatched、known/unknown、run 终态而 execution 非终态；注销/record/cancel/finalize 并发，无反锁；仅清原 active_execution |
| 查询限制 | 3 次、原 deadline+24h、无 ID/不支持 lookup/冲突/凭据换绑/预算不足；不重置次数、不新增 POST，不因 cron 重试产生额外预扣 |
| 金额 | 0157 冻结计价兼容、精确小数、一次取整、来源保护、一次消费/释放；退款后晚到成本只记平台；未知不是零 |
| 模糊写入 | 已提交但回包丢失先读回；去重不依赖用户 Auth；回执与终态重放无二次扣费、无回填正文 |
| 内容与擦除 | 正文/SDK/transport/gzip/Base64 canary 不进入封闭后证据或输出；B1b 屏障、擦除后不可逆、待结清绑定仍可核对 |
| 批次 | 单项失败隔离、并发重复触发、分页不饿死、60 秒预算、已关闭未决也入选、对账原检查不降级、未决年龄可见 |
| 保留与回退 | 年底起算三年、具体保全、财务完整性、暂停后重复推进；不能删证据或重新开放账号 |

后续实现必须跑文件建库/迁移重复执行/指纹、B2a SQL 和 BILL2/Runtime 集成、
相关 API/Web/lint/typecheck、安全与全部必需 CI；浏览器用隔离供应商夹具覆盖注销中途场景。
真实 staging 调用、供应商查询、原证据运行单恢复、迁移应用都另行取得相应授权。

## 7. 回退、交付与停止点

本方案文档回退：关闭 draft 或撤销单文件提交，无运行时/数据影响。
未来实施回退：停止新增财务补偿接线，保留账号封闭和原账务证据，排空在途写入后读回状态；
保留已应用投影/财务列，不反转终态、不恢复已擦正文、不恢复派发 token。
未出现新格式数据时才可按预先验证的旧定义结构回退；已产生新事实优先前向修复。
暂停期间明确报告未决积压，不能重新依赖已注销用户发请求。

本次只读完成方案/代码/审计一致性检查，未执行数据库或供应商操作；功能、并发、回退测试 NOT_RUN。
PR 的 CI 是现有仓库检查，不是缺陷已修复的证据；独立方案结论等待总控。
总控审阅本方案之前不实施。交付 draft、留下“可以审查”后本 writer 停止写入。
