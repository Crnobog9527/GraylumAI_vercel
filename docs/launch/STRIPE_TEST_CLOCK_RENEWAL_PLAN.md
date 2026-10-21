<!-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. -->
# PAY-STRIPE-MP：测试时钟续费验收方案

**状态：Owner 已批准，#1232 实施中，迁移 0329；真实 staging 验收待上库合并部署后执行。**

批准出处：[Owner 原话](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1232#issuecomment-6316079313)。
以下第 2–4 节保留批准前现场记录；不得将其当成实施后的新验收结果。

日期：2026-10-21（北京时间）。关联：[#1155](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1155)、
[#1230](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1230)、本实施 PR #1232。
证据中的 Stripe 时间统一标为 UTC；没有读取或记录登录凭证。

## 1. 目标、完成标准和边界

Owner 本轮要求：先用沙盒和系统现有恢复、退款、关单路径收尾 user3 的卡单，再核实测试时钟是否能验收续费，
提出最小方案；Owner 随后明确批准实施第 3.1、5 节，迁移号 0329。

完成标准：真实收尾记录；逐项时间校验及原因；精确限定环境和来源；保留保护；实施后验证和交接。
本 PR 按获批范围修改支付处理器、0329 迁移和对应测试；不修改规则、密钥或平台设置，不部署分支、不用 `--prod`，不伪造事件。
不把方案记作 Owner 已批准的产品决定，不修改 Master Plan。遇 hCaptcha 等人机验证立即停止并交 Owner。

## 2. 结论

1. 指定沙盒订阅已取消，$29 已全额退款成功；**站内订单仍未正常结束，user3 尚未恢复可重新购买**。
   已实际走正常恢复入口；现有路径要求先完成首期付款登记，时间冲突阻止登记，因此取消/退款 webhook 也等待它。
   在“不手工改数据库、不改代码”的本轮边界内，不能把该订单强制标记结束。详见第 3 节。
2. 首期下单前对齐时钟可以避开本次“付款早于订单”的问题，但**现状不能完成整套续费验收**：
   0238 明确拒绝远期 `paid_at`；即使只去掉该拒绝，积分释放与 24 小时宽限仍用真实时间，结果会不一致。
3. 推荐复用已存在的 staging/test-clock 入口与支付处理器，只给经服务器验证的 Pro 月付模拟来源提供业务比较时间。
   保留首期早付 5 分钟下界、相对付费周期检查、真实审计时间和全部现金/幂等保护。
   现有未履约全退订单的收口缺口也纳入本次明确批准的实施范围。

## 3. 卡单收尾：操作与实际结果

对象：user3 订单 `59fd6f7e-23df-4363-9a75-52f01a9eb002`，客户 `cus_VTrsBw6phNu824`，
时钟 `clock_1USu8Q3i2f0AJbrQ0zFNRyF5`，Stripe 沙盒账户 `acct_1SfbUz3i2f0AJbrQ`。

| 项目 | 操作 → 实际结果 | 状态 |
| --- | --- | --- |
| 取消续费 | 回读客户、订阅和 livemode=false；通过 Stripe 正常取消 API 取消 `sub_1USxCS3i2f0AJbrQ6oD4kj2S`，不生成新账单或按比例调整；回执 status=canceled | PASS |
| 全额退回 | 回读首期发票 `in_1USxCP3i2f0AJbrQwu5XHE4o`、成功付款 `pi_3USxCR3i2f0AJbrQ1ekSIyfZ` 和无既有退款；正常退款 API 退 2900 美分；`re_3USxCR3i2f0AJbrQ1HtkdNOZ` 状态 succeeded、USD 2900 | PASS |
| 正常恢复 | 用 user3 storageState 打开订阅页，再使用该原始 Checkout 的成功回跳入口恢复同一订单；没有人机挑战；payments.syncCheckoutSession 仍 HTTP 500 / INTERNAL_SERVER_ERROR，提示“同步支付会话失败，请稍后重试” | FAIL |
| 站内收口 | 只读回读仍 pending/unpaid/reserved；purchase_closed_at、fulfilled_at、subscription_id 均 null；仅 checkout 引用，无 payment 引用 | FAIL |
| 账户结果 | 页面及只读查询均 Free、467 积分；余额没有增加或扣减；旧退款订单保留。卡住订单仍占用购买流程，不能宣称可重新购买 | FAIL |

11:53–11:58 UTC 的真实取消、refund.created、refund.updated、charge.refunded、charge.refund.updated 和首期重试事件
均到达 staging，日志为 PAY_COMMON_WEBHOOK_HANDLER_FAILED。没有以退款回执冒充站内关单成功。

### 3.1 现有路径为何不能完成这一步

- [cardPaymentLookup.ts](../../packages/api/src/services/payments/cardPaymentLookup.ts) 通过 payment 引用匹配订单；
  本笔付款登记事务失败，只有 checkout 引用。
- [cardRefundWebhook.ts](../../packages/api/src/services/payments/cardRefundWebhook.ts) 找不到付款映射、但查到本地首期订单时，
  抛 PAY_STRIPE_MP_FIRST_PAYMENT_PENDING，等待原付款登记，防止退款漏记后又发权益。
- [cardSubscriptionWebhook.ts](../../packages/api/src/services/payments/cardSubscriptionWebhook.ts) 对未建本地订阅映射的最终取消
  也保持重试，避免丢失取消事实。
- [methodOrderSettle.ts](../../packages/api/src/services/payments/methodOrderSettle.ts) 对 paid Checkout 走正常履约；
  只有真实 expired/unpaid、真实异步付款失败或从未创建的 Checkout 才走对应关单。
  本笔 Checkout 全退后仍 complete/paid，不能冒充“未支付过期”关单。

**已批准的最小收口补充**：在第 5 节同样的三重限定内，给“首期未履约、真实全额已退、订阅已取消”的来源增加收口分支。
重新读取原 Checkout → 订阅 → 首期发票 → InvoicePayment → PaymentIntent/Charge → 每笔成功退款，验证完整唯一关联及退款总额；
锁住原订单、记录真实现金进出/税与 provider refs，释放原预约并结束原订单，不先开通会员或发积分。
复用现有退款账本、引用唯一约束和锁；无需新服务、队列或人工改历史数据。
缺少证据、部分退款、退款待处理、已有发放/并发冲突时维持待核对，不走该分支。
这是本次发现的现有路径缺口，按批准范围实现，**不允许通过直接 SQL UPDATE 代替现场恢复**。

## 4. 时间检查逐项核对

下表已用 staging READ ONLY 读取现存函数中的实际条件核对；原始迁移后来由 0296/0297 扩展 test/live 范围，
相关时间条件仍存在。API 从 Stripe 回读事实，不接受浏览器提交的付款金额或付款时间。

| 位置与条件 | 为什么存在 | 测试时钟的影响与建议 |
| --- | --- | --- |
| 0204 pay_waffo_observe_qualification：paid_at 非空、不得早于订单 created_at 减 5 分钟 | 防止把早已发生的付款套到新订单，容忍小幅时间差 | 本笔 paid_at=07:00，订单 created_at=10:54:21.339378 UTC，确实命中；**保留该下界**，以后每次新下单前先对齐时钟 |
| 同一函数：paid_at 不得晚于 clock_timestamp() 加 5 分钟 | 拒绝超前的收款事实 | 首期对齐后通常不触发；该首期路径不接受已经前推一个月的时钟创建新订单 |
| 0211 pay_waffo_fulfill_payment：结束时间等于购买的日历月/年；自动续费 paid_at 位于 start 减 5 分钟至 end 之前；非自动续费通常 start=paid_at | 防止错误期限、越期付款和不属于本周期的付款 | 使用同一模拟时间轴后这些相对关系仍应成立，全部保留 |
| **0238 pay_stripe_mp_renew_subscription：paid_at 不得晚于真实 clock_timestamp() 加 5 分钟** | 防止预先记入尚未发生的续费现金和权益 | 一个月后的真实模拟续费 paid_at 会超出该上界；这是需限定放宽的主要拒绝条件 |
| 0238：paid_at 不早于本周期 start 减 5 分钟、严格早于 end；周期锚点/期末须与冻结首期一致；禁止重叠已付周期 | 防止跨周期、提前套款、重复周期和错误月末算法 | 这些是来源内的相对时间与唯一性保护，全部保留，不因模拟而省略 |
| 0238 pay_stripe_mp_record_renewal_failure：failed_at 非空且不得超真实时间加 5 分钟 | 拒绝超前的失败事实；配合最早失败时间，防止后到重试延后 founder 截止日 | 当前 API 传 event.created；是否触发取决于事件字段，不能假定它跟随模拟时钟。见 4.1；当前方案保留该检查 |
| 0247 pay_stripe_mp_record_external_refund：refunded_at 非空且不得超真实时间加 5 分钟 | 拒绝超前退款事实 | API 传 refund.created；本轮该字段是实际 11:54:59 UTC，并非冻结的 07:00。当前没有放宽它的依据，保留检查 |

### 4.1 不能混为一谈的三种时间

- **业务对象时间**：本次首期 invoice.paid_at=1792566000（07:00 UTC），subscription.canceled_at 也是该模拟时间。
- **事件生成时间**：真实 invoice.paid 事件 evt_1USxCU3i2f0AJbrQgwp9Ep9s 的 created=1792580214（10:56:54 UTC）；
  取消事件 evt_1USy5h3i2f0AJbrQwa24XpRm 的 created=1792583637（11:53:57 UTC）。均不同于冻结时间。
  前推后的失败事件字段仍需现场核实；未实际前推，不能把未运行的情况写成必然拒绝。
- **传输/审计时间**：webhook 签名时间、请求接收时间、订单 created_at/fulfilled_at、数据库锁与任务预算使用真实时间。
  [webhook route](../../apps/web/src/app/api/stripe/webhook/route.ts) 的原始正文和 Stripe 签名验证保持原样，
  不关闭 SDK 的签名时间容差，不重写事件或对象时间。

### 4.2 不抛错，但会令验收失真的真实时间判断

| 位置 | 现状与原因 | 必需的限定适配 |
| --- | --- | --- |
| 0211 pay_waffo_grant_period | start_at 晚于真实时间就返回 0，防止尚未到期先发积分；年度 cron 也按真实时间挑期 | 已验证的模拟来源按其 clock 当前时间判断“该期是否已到”；仍按原 grant key 只发一次 |
| 0211/0238 的 profile 会员缓存更新 | 只有当前真实时间落在付费期内才更新，防止未来期提前改变当前会员 | 仅模拟来源按来源自身 clock 判断，保留其它真实来源；取消时的缓存重算也要一致 |
| 0214/0238 pay_common_membership_facts；API methodMembership.ts | 付费期开始/结束及结束后 24 小时宽限均用 now()/Date.now()；防止过期仍可用，宽限只保留会员、不发积分 | 数据库真实权益判断和页面投影都按同一来源的 clock；不能只改页面显示 |
| 取消回算和下一次购买的来源判断 | 付费期仍未结束时取消不等于失去会员；普通来源仍要保护到期前权益 | 仅模拟来源以其 clock 判断期末；其它未退款的有效会员仍拦截，不按整个账户统一切换时间 |
| 对账/恢复对象枚举 | 运行预算和查询窗口是墙钟，模拟对象的业务日期可能超前；测试时钟对象也不能依赖无客户过滤的全局枚举 | 从已冻结的本地来源获得 customer/subscription，定向回读并复用处理器；不改真实任务预算、保留日常对账规则 |

源码：[0211](../../packages/db/migrations/0211_pay_waffo_delivery.sql)、
[0214](../../packages/db/migrations/0214_pay_waffo_renewal_grace.sql)、
[0238](../../packages/db/migrations/0238_pay_stripe_mp_renewal.sql)、
[0247](../../packages/db/migrations/0247_pay_stripe_mp_external_refund.sql)、
[methodMembership.ts](../../packages/api/src/services/payments/methodMembership.ts)。

## 5. 已批准的最小方案

### 5.1 三重条件必须全部成立

1. **精确 staging**：复用 stripeTestClockStagingOpen / stagingRuntimeWindow，核对项目
   prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC、域名 auth-staging.graylum.com、仓库 Crnobog9527/GraylumAI_vercel、
   分支 staging 和 staging Supabase 主机 gvcpmcunmfrbxuwimxfa.supabase.co；使用现有
   STRIPE_TEST_CLOCK_CHECKOUT_ENABLED=true。Vercel 的 production 部署类别属于这个独立 staging 项目，
   不以 NODE_ENV/VERCEL_ENV 单独判断。Preview、main、其它项目/数据库均不匹配。
2. **真实 Stripe 沙盒事实**：resolveStripeScope 回读的商户/模式与订单引用一致，相关
   Customer、Subscription、Session、Invoice、付款、退款的 livemode 都必须 false；不能凭对象编号前缀判模式。
3. **客户实际挂时钟且关联唯一**：服务器回读 Customer.test_clock 和时钟对象，clock 为 ready，时间为有效整数；
   Customer 未删除、graylum_user_id 对应本账户，且与该订单冻结的 Checkout 请求、Stripe 订阅、发票、付款/退款链完全一致。

入口继续限制**国际银行卡 Managed Payments、Pro、月付**。缺任一条件即使用当前真实时间路径或拒绝该测试入口；
Gold、founder、年付、钱包、普通无时钟沙盒及 live 均不进入适配分支。
没有新增开放式客户端时间参数，也不把 URL 中的 customer 当成已验证授权。

### 5.2 时间适配的具体范围

- 增加一个内部“已验证 Stripe 测试时钟来源”上下文，复用现有 Stripe client 和冻结 checkout_request/provider refs。
  每次关键处理重新核对来源与 ready/frozen_time；失败时保留待恢复状态，不猜时间。
- **0238 续费 paid_at 的未来上界**：仅在上述限定成立时，以 Stripe clock.frozen_time 作为比较基准，仍保留 5 分钟容差。
  原始 paid_at/start/end 和现金事实按原值保存，不改写为服务器接收时间。
- **保留首期 paid_at >= order.created_at - 5 分钟**。老卡单已全退，按 3.1 收口，不靠放松下界把已退款付款重新发货。
  新首期只允许已对齐真实时间的时钟；延迟超过容差时重新核对并在下单前推进到当前真实时间。
- **失败与退款的未来检查暂不放宽**：当前实际来源分别是 event.created、refund.created，实测为真实时间。
  Pro 的 24 小时宽限按已付期末计算，不靠改写失败时间实现。若前推后的真实字段与当前证据不同，记录原文并暂停受影响步骤，
  不自行扩大批准范围。founder 7 天截止本轮不纳入。
- 为同一模拟来源的积分释放、权益事实、页面投影和取消回算传递相同的已验证比较时间。
  每笔真实来源仍用真实时间；不设置全局/全账户假时间，不改系统时钟、全局 SQL now()、签名校验或租约超时。
- 数据库接入使用受 service_role 限制的内部参数/重载，默认路径继续使用当前真实时间；
  在数据库端再次核对 test 模式、订单/订阅/商户/冻结客户关联，不能新增一个可由前端传 true 的 bypass 开关。
  实施采用 0329 内部 service_role RPC；现有付款函数签名与调用保持兼容，具体结构见第 8 节。
- 不新增表、队列或定时任务；复用订单快照、provider refs、退款账本和现有恢复/对账处理器。
  原始业务时间与真实处理时间保持可区分，测试上下文只影响限定业务判断。

### 5.3 放宽后仍保留的保护

- Stripe 原始正文签名与传输重放校验；provider API 权威回读，不接受浏览器金额、状态或时间。
- 用户/客户/订单/订阅/发票/Charge/退款归属，商户与 test/live 隔离；账户冻结、注销、条款和路由开关。
- 首期付款早于订单的 5 分钟下界；周期内付款、日历锚点、期末、无重叠已付周期检查。
- 冻结价格、续费不沿用首月折扣、币种、税和总实付核对；退款不得超真实已付，不把 pending 当成功。
- 订单、账户、来源锁，provider 唯一引用、发积分/退款幂等键；重复事件/并发仍只记账一次。
- 已退款/终止、拒付、删除账户不得重新发权益；宽限只保留会员，不产生积分；取消最终态不被旧事件重开。
- 所有审计时间、签名容差、工作预算和 Checkout 到期/锁超时仍是真实时间。

正式环境、live、无时钟客户走原路径；本方案的批准不等于正式环境授权，也不改变价格、权益或退款产品规则。

## 6. 批准后实施与验收

先修复并验证 3.1 的同一全退订单收口，再实现 5 节限定适配；两个范围在实施 PR 分开描述。
迁移编号已由 Owner 分配为 **0329**，按空库重复回放、指纹、兼容/恢复、最终版本 CI 和独立审查流程交接总控上库合并。

必须完成的验证（本地结果及部署后现场结果分别记录，不相互替代）：

1. 正式/livemode=true、普通沙盒无 clock、错误项目/域名/分支/数据库、客户错绑、缺失/advancing 时钟全部拒绝适配；
   现有真实时间的早付/未来拒绝结果不变，数据库普通签名/ACL 保持兼容。
2. 首期：每次下单前先把时钟推进至当前真实时间、等 ready、回读；正常 user3 Checkout，只提交一次；首期 +3480、订单一笔。
   若时钟已经在未来，不能倒拨；暂停新下单，按获批测试准备流程换新时钟/客户，不用未来时钟硬买首期。
3. 成功续费：推进到下一期，等 Stripe ready 和实际发票最终支付；核对 subscription_cycle、订单一次、积分 +3480；
   重复/并发和两个真实 paid 事件仍不重复发积分。没有真实已付续费不得开始退款验收。
4. 失败续费：使用官方可绑定但扣款失败测试卡，逐段记录 attempt_count、下一次重试、真实事件时间与对象模拟时间；
   在期末、+23:59、+24:01 核对数据库权益和页面宽限；不发积分；观察第 1/3/6 天重试和最终取消。
   若 Stripe 当前真实重试策略不同，记录 FAIL/NOT_RUN 和实际安排，不临时改平台设置使验收通过。
5. 续费退款：只退本轮真实成功续费对应款项，核对税/退款金额、同一订单、来源积分回收、取消状态和重复退款幂等。
6. 卡单收口：全额成功退款+取消+未履约才结束原订单；部分/待处理/失败退款、错客户、已有授予与并发不得误关；
   已全退的旧付款迟到事件不得再次发货。确认 user3 正常新购不再被旧 pending 阻塞。
7. 每项写“操作 → 实际结果 → PASS/FAIL/NOT_RUN”，记录每阶段订单、积分、模拟/真实时间和未验证部分，写回 #1155。
   登录运行 node ~/.graylum/staging-login user3，使用生成 storageState；过期重跑；不读取、不记录凭证。
   仅沙盒/测试卡，遇 hCaptcha 等立即停止交 Owner，不尝试通过；无分支部署、无 --prod。

恢复策略：关闭既有测试时钟入口可停止新增模拟购买；保留所有真实 Stripe 沙盒现金事实及站内账本，
已前推模拟对象不能通过“撤回代码”恢复成真实时间。继续复用正常恢复/退款收口，不删历史账务，不手工改库。

## 7. 证据与未验证项

已核实：正常取消与 $29 退款；正常浏览器恢复失败；staging 只读函数条件、订单/积分/引用；真实事件和对象时间不同。
代码与本地验证已实施：15 个 API suite 382/382；数据库支付整套 225 项；332 步空库建库、263 次重复回放、指纹刷新及收敛/中断恢复。
本地测试通过不代表真实订单已处理。未完成：user3 站内关单及可重新购买；前推一个月后的真实 paid/failed/退款流程；最终 CI/机器人门禁及部署后现场验收。正式环境不在授权范围。
当前三项续费保持 NOT_RUN；本轮未新下单、未推进时钟、未伪造事件。无 hCaptcha 等人机挑战。

参考资料（2026-10-21 核对）：
- [Stripe 测试时钟 API 与限制](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage)：只能前推，需等待 ready；月付每次最多推进两期，续费发票可能先 draft 再结算。
- [Stripe webhook 签名与投递处理](https://docs.stripe.com/events/manage-webhook-endpoints)：保留原始签名校验和真实事件重试/幂等。

## 8. 实施结构与交接

- API 每次关键处理回读 Stripe 商户/模式、Customer 所有者及真实 clock；仅精确绑定环境调用观察 RPC。
  冻结 customer 的普通订单不存在适配上下文；live 和环境不匹配不新增 provider/DB 操作。
- 0329 复用原首期 payment_orders.metadata.stripeTestClock 保存服务器观察，续费按 source_order_id 回到原订单；
  核对 test、商户、用户、国际卡、MP、Pro 月付、冻结 customer、绑定常量后才能取得来源比较时间。
  同一 clock 观察只前进，不允许重新绑定。未通过的来源继续原来的真实时间。
- 时间修改只覆盖续费未来上界、当期积分释放/会员缓存、权益事实/页面宽限、取消回算与到期再购。
  首期资格观察、失败/退款事件时间、审计时间、租约、Checkout 到期和对账预算保持原规则。
- 全退收口 RPC 在 canonical 订阅/付款锁、profile 和 order 锁下核对全额现金进出与税、支付/退款唯一引用，
  拒绝已有发放、订阅、退款审批、拒付、注销和异常状态。原单变为 refunded/refunded/released，保留未履约，积分 0。
  重放同一证据只返回 duplicate；迟到已付事件继续走原有 refunded 阻断。
- 没有新增表、列、队列、定时任务、密钥或平台设置。数据库通过锚点修改最新函数，未知函数正文即中止；
  新 RPC 仅 service_role 可用；原付款调用兼容。测试覆盖重复应用与中途中止后的结构和 ACL 一致。
- API/本地 DB/CI/机器人结果见 PR 当前交接评论；staging 真实 user3 卡单收口和三项续费在总控上库合并、正常部署后才执行。
  未执行的现场项目保持 NOT_RUN，结果写回 #1155。

恢复：先停止新的模拟购买和继续前推，保留所有 Stripe/数据库账务；按同一来源向前修复或正常退款，
不通过恢复旧代码丢掉已模拟的时间事实，不删除金融数据，不手工改远程数据库。
