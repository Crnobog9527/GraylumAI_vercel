# PAY-WAFFO：Waffo 待问问题复查（第 4、7 题只读查询，第 5 题样例分析）

risk: ordinary。本目录只有脱敏证据和查询；不改应用代码、依赖或计费行为。

- 授权：Owner 2026-10-11 在总控窗口同意用 Waffo 测试密钥在测试模式下实测第 3、4、7 题，
  不花真钱、不改后台。之后总控按 Owner 意思把范围收窄为：**第 3 题不做**；第 4、7 题只读查询；
  第 5 题只根据已有样例说明。随后 Owner 定下收款方案：正常流程自动处理，少见情况靠每天对账加人工处理，
  Waffo 只问必须问的问题（第 5 节据此精简）。
- 题号指 [#802 证据 README](../waffo-test-20261011/README.md) 第 4 节。本目录不修改 #802 的任何文件。
- 查询时间：2026-10-11 11:08–11:10 UTC（北京时间 19:08–19:10），比 #802 记录晚约 5 小时。
- 凭据只由脚本从 `~/.graylum/secrets/waffo-test.env` 读取（文件声明 `WAFFO_ENV=test`），
  没有输出、复制或落盘。执行脚本就是 #802 的 [`scripts/probe.mjs`](../waffo-test-20261011/scripts/probe.mjs)
  原样副本（只允许 GraphQL 只读请求、固定 api.waffo.ai、自动脱敏），在仓库外的私有目录执行。
- 店铺号已遮盖；`pspRefundId`（支付通道侧退款号）也遮盖为 `[MASKED]`。其他编号是 #802 已公开的测试标识。
- 这次一共 4 个只读请求：预检、整份 schema 读取（只留在本机，未提交）、第 4 题、第 7 题。
  **没有任何写请求**：没有新建结账会话、退款、取消，也没碰后台设置。没有启动浏览器。

**重要：下面全部是测试模式里观察到的现象，不等于 Waffo 的承诺。** 能不能当契约用，要以 Waffo 书面答复为准。

## 0. 预检

[preflight.json](samples/preflight.json)：指定店铺 active、isLive=false、prodEnabled=false、回调数 0。
确认仍是测试店铺后才执行下面的查询。

## 1. 第 4 题：退款 `TKT_2knvdNCFjn5IQbwbBPUDpJ` 现在的状态

查询：[q4-refund.graphql](queries/q4-refund.graphql)；结果：[q4-refund.json](samples/q4-refund.json)。

**实测看到什么**（对比 #802 的 [refunds-latest.json](../waffo-test-20261011/samples/refunds-latest.json)，当时 06:08 UTC）：

| 字段 | #802 记录时 | 现在 |
| --- | --- | --- |
| refundTicket.status | processing | **succeeded** |
| refundTicket.executedAt | null | 2026-10-11T06:30:03.078Z |
| refundTicket.updatedAt | 06:00:37 | 06:30:03.078（与 executedAt 相同） |
| payment.refundStatus | pending | **refunded** |
| payment.refundedAmount | 0 / 0.00 | 4900 / 49.00 USD |
| payment.isFullyRefunded | false | true |
| payment.refunds | 空 | 1 条：`REF_6gEPvfDzB3ji1Wz5ksQAtE`，status=succeeded，49.00 USD，createdAt 06:30:03.160Z，isPostSettlementRefund=false，pspRefundId 有值 |
| 关联订阅 `ORD_7VXQfDMnduUc7PPSHThDol` | trialing、willRenew=true | **仍是 trialing、willRenew=true**，canceledAt=null，updatedAt 仍是 05:58:33 |

- 退款工单创建（06:00:36）到执行成功（06:30:03）约 **29.5 分钟**。中途没有任何人工操作或后台改动。
  这只是测试模式的一次观察，不能推断正式环境耗时，也不知道是否固定按 30 分钟批处理。
- 全额退款后，订阅本身**没有**被取消或停止续费，仍会按原日程续费（测试模式）。
- 金额字段格式依旧不统一：`refundedAmount.amount`、`refunds.amount.amount` 是最小单位（4900），
  `pspAmountDetails.amount` 是主币单位字符串（"49.00"）。
- 退款记录 `refunds[].createdAt`（06:30:03.160）比工单 `executedAt`（06:30:03.078）晚 82 毫秒，
  两者都不是"钱到买家卡上"的时间。

**能不能当契约用：** 只能当观察。能确定的是：测试退款会自己从 processing 推进到 succeeded，
推进后 ticket.status、ticket.executedAt、payment.refundStatus/refundedAmount/isFullyRefunded 和
payment.refunds 会一起变化，可以用这些字段查回最终结果。处理需要多久、会不会失败、失败长什么样、
退款会不会影响订阅，都没有供应商保证。

**还要问 Waffo：** 按 Owner 决定不再追问（退款走人工）。未知的部分：处理时长（正式环境）、失败时的状态、"已到账"字段、退款回调。

## 2. 第 7 题：已取消的月付订阅现在的状态

查询：[q7-order.graphql](queries/q7-order.graphql)；结果：[q7-order.json](samples/q7-order.json)。
订单 `ORD_1ug9i0Dp6bc09NM9KSVebH`（[cancel-monthly69.json](../waffo-test-20261011/samples/cancel-monthly69.json) 取消的那笔）。

**实测看到什么：**与 #802 的 [orders-page1.json](../waffo-test-20261011/samples/orders-page1.json) 相比**完全没变**。

- status 仍是 `canceling`，willRenew=false，updatedAt 仍是取消时刻 06:00:42.273Z。
- canceledAt=2026-10-11T06:00:42.273Z：写入的是**发起取消的时间**，不是订阅真正结束的时间。
  现在还没有出现 `canceled` 状态，也就无从知道 canceled 写在什么时候、写在哪个字段。
- 付到哪天：`currentPeriodEnd` = `currentPeriod.end` = 2026-11-11T05:59:47.000Z，取消后没变。
  `currentPeriodNumber`=1，`activateAt`=05:59:48.965Z。schema 里没有 paidThrough / endedAt 这类单独字段。
- 付款 `PAY_75GUpbGyKtYlL8lruMCQAS`：`settlementInfo` 仍为 null（付款后 5 小时多）；
  可用的时间只有 `createdAt`=05:59:48.325Z，这是记录创建时间，不是经确认的扣款时间。
- 单条查询 `subscriptionOrder(id)` 和列表查询 `subscriptionOrders(filter)` 对同一订单返回一致的值。

**能不能当契约用：** 在 canceling 状态下，`currentPeriodEnd` 是唯一像"付到哪天"的字段，可以暂时这样用，
但到期后它是否保持不变、canceled 状态何时写入，要等 2026-11-11 之后再查，或由 Waffo 说明。
`settlementInfo` 不能当作"付款时间"的来源，因为它可能长时间为空。

**还要问 Waffo：** "付到哪天"和"真实付款时间"并入第 5 节第 1 题；canceled 何时写入按 Owner 决定不再追问。

**后续可以再查一次：** 2026-11-11 05:59 UTC 之后，用同一个 [q7-order.graphql](queries/q7-order.graphql)
只读再查，看是否已经出现终态（到期后状态何时变化未知，可能仍是 canceling；是否执行按当时规则另行确认）。

## 3. 第 5 题：metadata 从哪条路径能稳定拿到（只根据已有样例）

没有为第 5 题单独发请求。第 7 题的查询里顺带读了订单 metadata，一并列出：

| 读取路径 | 样例 | metadata |
| --- | --- | --- |
| 列表 `subscriptionOrders(storeId, filter)` | #802 [orders-page0/1/2.json](../waffo-test-20261011/samples/orders-page1.json)；本次 [q7-order.json](samples/q7-order.json) | JSON **字符串** `{"orderId":"graylum-waffo-20261011-…"}`，三笔订单都有 |
| 单条 `subscriptionOrder(id)` | 本次 [q7-order.json](samples/q7-order.json) | 同上，JSON 字符串，有值 |
| 嵌套 `payment.subscriptionOrder` / `payments[].subscriptionOrder` | #802 payment-intro49/monthly69/annual496、payments-first/second/three | **全部是 null**（6 个样例、3 笔订单） |
| 创建会话时传入 | #802 session-*.json | 传入时是对象 `{orderId: …}`，读回来变成字符串 |

**结论：** 目前看到的稳定路径是**直接查订单**（列表或单条），不是从付款里嵌套带出来。
嵌套路径在所有样例里都是 null，所以 null 不能理解成"没有 metadata"。
读回来的是字符串，需要自己解析 JSON。另外 `orderMerchantExternalId` 在订单、付款、退款里都直接有值，
比 metadata 更适合当本站订单号的关联字段。

**能不能当契约用：** 不能。这是 3 笔测试订单的一致现象，不知道嵌套为 null 是有意设计还是缺陷，
也不知道以后会不会改。#791 现在的 `readSubscription` 已经只走列表查询，和这个观察一致。

**还要问 Waffo：** 按 Owner 决定不再追问。未知的部分：嵌套为 null 是否有意、哪条路径是正式契约、metadata 为何变成字符串。

## 4. 第 3 题：未做

范围收窄前没有开始。没有新建任何结账会话，也没有做重复、并发或分页一致性测试。
按 Owner 决定，第 3 题也不再追问 Waffo（见第 5 节）。

## 5. 精简后的待问清单（给 Owner 转问 Waffo）

Owner 2026-10-11 已定收款方案：**正常流程（首次付款、续费、升级、取消）自动处理，少见情况靠每天对账加人工处理，
Waffo 只问必须问的问题。** 按这个标准，只保留"不问就做不了正常流程或每天对账"的问题。结果剩 2 题。

### 必须问（2 题）

**第 1 题 中文：** 续费和每天对账时，我们要知道每笔付款"什么时候扣的、管哪段会员期"。请确认：
(a) 付款的 `createdAt` 是否就是扣款成功时间？`settlementInfo` 在付款 5 小时后仍为空，它什么时候才有值？
(b) 一笔续费付款覆盖的会员期起止，是否等于这笔付款成功时订阅的 `currentPeriodStart`/`currentPeriodEnd`？
事后（比如下一期已扣款后）还能按付款编号查回这一期的起止吗？
(c) 用户取消后，`currentPeriodEnd` 是否就是"已付到期日"，到期前会不会再变？

**Question 1, English:** For renewals and daily reconciliation we need to know, for each payment, when it was charged
and which service period it covers. Please confirm:
(a) Is `payment.createdAt` the time the charge succeeded? `settlementInfo` was still null 5 hours after a
test payment — when is it populated?
(b) Does a renewal payment cover exactly the subscription's `currentPeriodStart`/`currentPeriodEnd` at the
moment that payment succeeds? Can that period still be retrieved by payment ID later, e.g. after the next
period has been charged?
(c) After a cancellation, is `currentPeriodEnd` the authoritative paid-through date, and can it change before it is reached?

为什么必须问：续费到账后要按这一期的起止给会员时长，每天对账要按扣款时间和金额核对；
现在接口里没有付款对应的账期字段，结算信息又长时间为空，只能靠推断。

**第 2 题 中文：** 用户打开结账页后没付款就离开，我们的服务端怎样确认这个结账会话已经过期或关闭、之后不可能再付款成功？
有没有按会话编号（或我们传入的 `orderMerchantExternalId`）查会话状态的接口？如果过期时刚好有一笔付款在处理中，最终会怎样？

**Question 2, English:** When a buyer opens a checkout session and leaves without paying, how can our server
confirm that the session is expired or closed and can no longer result in a successful payment? Is there an API
to read a checkout session's status by session ID (or by the `orderMerchantExternalId` we supplied)?
If a payment is in progress at the moment the session expires, what is the final outcome?

为什么必须问：[PAY-WAFFO 任务文档第 6 节](../../tasks/PAY-WAFFO.md)规定，创始和 Gold 名额的预留
"只在供应商确认会话关闭/过期且未付后释放"。用户放弃付款是正常流程，而 #802 已确认当前公开接口没有会话状态查询。
（机器人审查指出，见 #808。）如果 Waffo 答复没有这种接口，是否改成"过期时间过后查不到订单就释放、迟到付款转人工"，
属于对已定设计的改动，要由 Owner 决定，本 PR 不替 Owner 定。

### 按 Owner 决定不再追问

| #802 原题 | 处理 |
| --- | --- |
| 1 历史账期和实际付款时间 | 只保留续费和对账必需的部分，并入上面这一题；月底、闰年等样例不再要 |
| 2 结账会话查询、过期后迟到付款 | 会话状态确认是名额预留释放的前提，保留为第 2 题；其余细节不再追问 |
| 3 幂等键范围、分页一致性、写后多久可查 | 不再追问，也不实测；对账按已过去的时间段查，避开写入中的数据 |
| 4 退款为什么卡在 processing | 按 Owner 决定不再追问，退款走人工。观察：这一张工单约 30 分钟后变成 succeeded（见第 1 节），这只是一次样例，不是处理时长的答案 |
| 5 嵌套 metadata 为 null | 不再追问；直接查订单或用 `orderMerchantExternalId` 关联（见第 3 节） |
| 6 SDK 何时补齐、文档示例不一致 | 不再追问；不影响正常流程 |
| 7 取消后何时写 canceled、付款时间字段 | "付到哪天"和"付款时间"并入上面这一题；canceled 何时写入不再追问，2026-11-11 后可自己只读查一次 |

## 6. 发现的问题

- 全额退款不会自动取消订阅（测试模式观察）。#791 的月付退款流程已经设计了"停止续费→退款→取消"
  分开的步骤，和观察一致；本 PR 不改 #791，只提醒 #791 不要假设退款会顺带关闭订阅。
- 这次退款约 30 分钟后才变成成功（一次样例，不是承诺的时长），期间工单是 processing、付款是 pending。业务上查回时要把 processing/pending
  当作"未完成"，不能当作失败去重复发起退款。
- `settlementInfo` 付款后 5 小时仍为 null；#791 若用它当付款时间会拿不到值。
- 月付订阅 `ORD_1ug9i0Dp6bc09NM9KSVebH` 最早要 2026-11-11 之后才可能看到终态，具体何时变化未知。

## 7. 结账链接形状（为 #791 浏览器验收做的只读核对）

总控追加的核对，不新建任何东西、不发 Waffo 请求：读取 #802 实测时保存在仓库外私有目录的 4 个结账会话创建响应
（intro49、monthly69、annual496、expired），脚本只输出链接的结构，不输出完整链接。仓库里 #802 的
[session-*.json](../waffo-test-20261011/samples/session-intro49.json) 已把 checkoutUrl 整体遮盖。

- **路径形状：** 4 个链接全部是 `https://pancake.waffo.ai/store/<店铺链接名>/checkout/<sessionId>`，
  共 4 段路径，**都以 `/checkout/<sessionId>` 结尾**，没有 query，没有 `#` 片段，不含账号密码。
  这和 #791 `validateWaffoCheckoutSession` 的结尾检查一致。
- **sessionId：** 4 个都是 `cs_` 加 36 位小写十六进制和连字符，符合 #791 的格式校验；`expiresAt` 都是合法时间。
- **域名（origin）：** `https://pancake.waffo.ai`，是 Waffo 公开的结账域名，可以写出。#791 的 `allowedCheckoutOrigin`
  在测试模式下应配置为这个值（只根据测试模式样例；正式环境的结账域名没有核对）。
- **敏感信息：** `<店铺链接名>` 是这家店铺专属的标识（不是店铺编号 STO_…，也不含商户编号 MER_…），
  所以在证据里打码。#791 的检查只看 origin 和路径结尾，不依赖这一段。

能不能当契约用：只是 2026-10-11 测试模式 4 个样例的现象；路径格式和域名没有供应商书面承诺，正式模式未核对。
