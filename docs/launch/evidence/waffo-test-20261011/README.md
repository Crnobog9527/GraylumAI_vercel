# PAY-WAFFO：Waffo 测试模式真实接口证据与 SDK 评估

risk: ordinary。本 PR 只有脱敏证据、查询和独立脚本；不改变应用、项目依赖或计费行为。
外部测试产品、测试付款、一次测试退款及取消操作已获得本次 Owner 授权。
**只交接，不合并。不能据此宣称 #791 第 2 步完成或可以启售。**

- 授权：[Owner 评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/791#issuecomment-6105725079)及本实测任务的明确要求。
- 回答对象：[#791 评论 6105234636](https://github.com/Crnobog9527/GraylumAI_vercel/pull/791#issuecomment-6105234636)。
- 基线：`origin/staging` 的 `3f6fb8b6df5ed0ebbd2149c69a237f388c2f5114`。
- 比较实现：#791 `d931f0302647dde634facec7bea77b1d6f91176d`，只读取，不修改。
- 日期：2026-10-11（北京时间）；JSON 内接口时间为 UTC，`capturedFileAt` 为脱敏响应落盘时间。
- 凭据只从 `~/.graylum/secrets/waffo-test.env` 读取，不复制、不输出、不落盘；没有记录请求头或签名。
  商户/店铺号、买家字段和结账 URL 已遮盖。产品、订单、付款、退款和会话编号为本次非敏感测试标识。
- 本机 SDK 安装和执行目录在仓库外；`scripts/` 是独立复现实测材料，不属于 pnpm workspace。
  没有改 staging 配置、注册回调、发布正式产品或使用真实付款方式。

## 1. 已完成的实测

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 测试绑定 | PASS：指定店铺 active、isLive=false、prodEnabled=false、payinEnable=true；回调数为 0；三笔付款均 testMode=true | [预检](samples/preflight-final.json)、付款样例 |
| 六个产品 | PASS：均为 active、hasProdVersion=false；不触碰预先存在的两个产品 | [查询](samples/products-read.json)、下表 |
| 首 30 天 49 美元 | PASS：浏览器订阅成功，API succeeded；PSP 实付 49.00 USD，期数 1，trialing | [原始首期](samples/payments-first.json)、[按付款 ID 查询](samples/payment-intro49.json) |
| 普通月付 69 美元 | PASS：浏览器订阅成功，API succeeded；PSP 实付 69.00 USD，期数 1 | [付款查询](samples/payment-monthly69.json) |
| 创始年付 496 美元 | PASS：浏览器订阅成功，API succeeded；PSP 实付 496.00 USD，期数 1 | [付款查询](samples/payment-annual496.json) |
| 49 美元退款 | PARTIAL：已受理，ticket=processing；付款 refundStatus=pending，已退额 0，无已执行退款记录。**没有确认退款成功** | [创建](samples/refund-intro49.json)、[查回](samples/refunds-latest.json) |
| 月付订阅取消 | PASS（停止续费请求和查回）：canceling、willRenew=false，保留最后已付期限到 2026-11-11。尚未等到终态 canceled | [取消](samples/cancel-monthly69.json)、[查回](samples/orders-page1.json) |
| 未付过期会话 | PASS（浏览器）：创建时 TTL=60 秒，过期后页面显示“此结账链接已过期”。对应业务编号未查到订单/付款；这不证明不存在迟到款 | [创建](samples/session-expired.json)、[空查询](samples/expired-order.json)、[浏览器记录](browser-observations.md) |
| 原会话重放 | PASS（有限范围）：同一请求和同一显式幂等键重放，返回完全相同的 sessionId、expiresAt | [重放响应](samples/session-expired-replay.json) |
| 订单分页 | PASS（本次静态集合）：limit=1，offset=0/1/2 分别取回三笔订单，offset=3 为空，总数 3，无重复 | [页 0](samples/orders-page0.json)、[页 1](samples/orders-page1.json)、[页 2](samples/orders-page2.json)、[页 3](samples/orders-page3.json) |
| 会话查询 API | BLOCKED：实际 GraphQL schema 无会话类型/查询；`checkoutSession` 请求返回不支持。没有把创建响应当作状态查询 | [实际错误](samples/session-query.json)、[schema 摘录](samples/schema-selected.json) |

普通月付 69 和创始年付 496 **都是独立订阅的首笔付款**，并不是同一订阅的 49→69 自动续费，
也不是创始第二年续费。首次 49 的当前账期为 2026-10-11 至 2026-11-10，正好 30 天；
69 月付为 2026-10-11 至 2026-11-11；496 年付为 2026-10-11 至 2027-10-11。

### 六个产品编号

| 产品 | USD 配置 | 编号 |
| --- | --- | --- |
| Gold 首 30 天优惠月付 | trialAmount=49.00、trialDays=30，之后 amount=69.00/monthly | `PROD_6bacQZwfKBSKqsuRzGmYaN` |
| Gold 普通月付 | 69.00/monthly | `PROD_3FNIDuKdkVgvIfd0O4vUzZ` |
| Gold 年付 | 621.00/yearly | `PROD_0ZleshD5LEYuTruuiVEBNs` |
| 创始年付 | 496.00/yearly | `PROD_25Zmm7PVC68mtzM2XkZZAC` |
| Pro 月付 | 29.00/monthly | `PROD_3JKZPZdJtcSdu9dXdNuJQT` |
| Pro 年付 | 279.00/yearly | `PROD_2qOnkXjXAGhsxLrbTGsUSb` |

产品名带 `[Test 1011]`；metadata.evidenceRun=`graylum-waffo-20261011`；均使用 saas 税种。
本次香港结账页显示税额 0，实际三笔扣款等于上述金额，不代表其他国家税制已验证。

## 2. 对 #791 四组问题的逐项回答

### 2.1 原付款实付

**已实测确认：** SDK `client.graphql.query` 调用 `payment(id: String!)` 可唯一取回三笔成功付款。
`pspAmountDetails.amount` 返回主币单位字符串 `49.00`、`69.00`、`496.00`；`currency=USD`。
`amount.amount` 分别为 `4900`、`6900`、`49600`，`amount.display` 为主币单位，不能混用。
`paymentMethod.type=card`、`testMode=true`、`orderId`、`orderMerchantExternalId` 均存在；
经 `subscriptionOrder.storeId` 回到指定测试店铺。请求使用指定商户签名成功，但没有对另一商户执行越权负向测试。

退款状态可查，累计已退额有 `refundedAmount`；本次仍为 0。`createdAt` 是记录创建时间，
不是已证明的 PSP 实际支付时间。`settlementInfo.paymentSuccessTime` 存在于 schema，
但本次 `settlementInfo=null`，不能说已结算。`pspAmountDetails.settlementAmount` 有值也不证明结算完成。
退款 ticket.metadata 内部分金额是整数分，而 GraphQL pspAmountDetails 是显示字符串，必须按字段契约处理。

**未实测：** 真正第二期 69、创始第二年 496、最终退款金额/时间、结算及精确实际付款时间。

### 2.2 原付款对应原账期

**已实测确认：** `Payment.periodNumber=1`，付款可关联原订阅订单。订阅提供 currentPeriodStart/End/Number。
实际 Payment schema **没有 periodStart/periodEnd、paidAt 或 checkoutSessionId**。
官方文档称 Payment.periodNumber 固定于当次付款，但本次只有首期，未用第二次付款证明其历史不可变性。

**未实测：** 第二次付款发生后查询第一次；月底、闰年、乱序回调、失败续费占用期数及重试。
[官方测试模式文档](https://docs.waffo.ai/features/test-mode)提供 Dashboard 模拟续费按钮，
本次 SDK 0.26.0 没有公开模拟续费方法，未进入商户后台或调用未公开模拟接口。
没有把当日首笔收款和当前账期拼成“历史账期已验证”。

### 2.3 本站原会话与创建恢复

**已实测确认：** 商户签名创建会话时设置的 `orderMerchantExternalId` 保留在订单和付款，
按它过滤能查到原对象。独立 `subscriptionOrders` 查询保留 `metadata.orderId`，实际为 JSON **字符串**。
但从 `payment.subscriptionOrder` 嵌套查询得到的 `metadata=null`，两条路径有差异，不能通用依赖嵌套值。
付款与订单 schema 均没有原 checkout sessionId；只能证明本站业务编号关联，不能证明 sessionId 反查能力。

显式 `X-Idempotency-Key` 重放返回原过期会话，证明短时间同键重放；
未人为制造网络丢包，未证明 24 小时边界、跨接口/商户键范围及并发处理。
[SDK 0.26.0 RequestOptions](https://github.com/waffo-com/waffo-pancake-sdk-ts/blob/main/docs/api-reference.md)
说明 2xx 缓存 24 小时、处理中重复为 409、非 2xx 不占键，键唯一性由调用方负责——这些是文档事实。
0.23 起 SDK 不再自动生成键，本次每个写请求均显式指定独立键；GraphQL 不加缓存键。
分页只在本次无新增写入的三笔静态集合通过，不等于高并发分页一致性或延迟保证。
空列表不得用于认定“创建从未发生”。

### 2.4 关闭与取消

过期未付会话在浏览器明确拒绝，但公开 GraphQL 没有商户会话状态接口；
无法由服务端取得权威 expired/closed 终态及迟到付款处理契约。
取消操作返回 `canceling`，查回 `willRenew=false`、canceledAt 有值，currentPeriodEnd 不变。
官方说明 active/trialing 取消后到已付期末才终止；本次不把 canceling 当作 canceled。
未验证到期终态、续费失败/失败时间、重复失败后的终止，以及取消后边界时刻是否仍可能发生款项。

## 3. SDK 评估

| 项目 | 本次结论 |
| --- | --- |
| 版本 | npm 精确安装 `@waffo/pancake-ts@0.26.0`，2026-10-10 发布；Node >=20；无运行时依赖 |
| 许可 | 包内 LICENSE 和 package.json 均为 MIT；没有将 SDK 源码或依赖加入本仓库 |
| 维护 | 官方 `waffo-com/waffo-pancake-sdk-ts` 未归档；最后推送 2026-10-10；本次读取 0 open issues。3–10 月持续发版，有 changelog；不能据此推断 SLA |
| 产品/结账/取消 | 公共资源实测可用：subscriptionProducts.create、checkout.anonymous.create、orders.cancelSubscription |
| 付款/订单/订阅查询 | GraphQL 通用 query 可用；SDK 不提供完整生成的查询 schema/强类型领域查询，字段仍须按实际 introspection 校准 |
| 会话查询 | 未覆盖：既无公共 SDK 方法，也未在当前公开 GraphQL schema 发现 |
| 商户退款 | 公共 `client.refunds` 不存在。只有 customer.createRefundTicket（Bearer 客户端）和其类型；本次退款用 **SDK 内部 client.http.post** 签名调用官方 `/v1/actions/refund-ticket/create-ticket`。这是临时实测适配，**不是稳定公共 SDK 支持，不建议业务代码依赖私有属性** |
| 请求签名 | 与 #791 的 POST + path + 秒级 timestamp + SHA256(body) base64 的 RSA-SHA256 算法一致；临时生成测试密钥、固定时间、相同取消请求时，请求头逐字节相同（不输出签名） |
| Webhook 验签 | 同样验证 `毫秒 timestamp + '.' + 原始 body` 的 RSA-SHA256；正常签名通过，篡改和未来 61 秒均拒绝；**策略不完全一致**，见下文 |
| 网络保护 | SDK 默认未设置超时/禁止重定向；本次自定义 fetch 固定主机和端点、30 秒超时、redirect:error、无自动重试。业务接入仍需保留既有保护 |

签名对照为 **6 项本地合成测试**，不是 Waffo 真回调实测，结果见 [signing-test.json](samples/signing-test.json)：

- 46 分钟前的有效回调：SDK 默认直接拒绝；#791 验签后只标记 requiresLookup=true 并转权威查询。
- 逗号后带空格的签名头：SDK 接受，#791 严格正则拒绝。
- #791 额外验证店铺、test 模式、消息 schema 和大小；SDK 验签成功后只解析 JSON。
  SDK 未明确 environment 时会尝试正式和测试公钥；业务接入不能省略 test 约束。
- SDK 会规范化 PEM/字面量换行并有默认公钥；#791 要求显式 key。不能直接替换后宣称行为等价。

**建议交给总控的决定：** SDK 可以减少签名及 REST 请求维护，但目前不是完整查询恢复契约，
也不能原样替代 #791 的安全边界。先请 Waffo 补齐下节问题，再由总控请 Owner 决定是否采用；
本 PR 不替换实现、不增加应用依赖。

## 4. 需要总控转 Owner 向 Waffo 询问

1. 给定原 paymentId，哪里取得 **当次历史 periodStart/End** 及精确 paidAt？请提供第二期后查第一期、
   49→69、创始年续 496、月底、闰年、乱序/失败重试样例；不要只给当前订阅账期。
2. 商户原 checkout sessionId 的状态/订单关联/按本站编号恢复接口在哪里？无订单的会话如何查回？
   过期/关闭与迟到付款的终态规则是什么？当前公开 schema 没有 checkoutSession。
3. 幂等键准确的商户/环境/接口作用域、24 小时起算点、参数不同时的行为、并发 409 和响应丢失恢复；
   offset 分页一致性、写后可见延迟/最大滞后、空查询等待规则。
4. 退款 `TKT_2knvdNCFjn5IQbwbBPUDpJ` 为何持续 processing？测试退款怎样推进成功/失败，
   如何验证最终已退额、到账时间及退款对 trialing 订阅的影响？不要再次创建同款退款。
5. 为何 `payment.subscriptionOrder.metadata=null`，但独立 subscriptionOrders 返回原 metadata？
   哪种读取路径是完整契约？实际扣款缺失时金额字段是否可能用目录价格回填？请明确 null/未知规则。
6. SDK 何时公开支持商户退款、会话查询与测试续费模拟？请同步文档中 `ID!`/`String!`、
   prices 对象/列表、`client.refunds.createTicket` 不存在及退款 `/api`/`/v1` 示例差异。
7. 取消后何时写 canceled，失败时间和最终 paid-through 的权威字段是什么？结算信息为空时如何取真实支付时间？

## 5. 发现的问题与交接

- #791 `waffoTestOperationsClient.ts` 的 readProduct 使用 `$storeId: ID!`，当前接口返回 `Unknown type "ID"`。
  本任务不修改 #791，交由该 PR 的负责人同范围修复并验证。
- 退款完成、实际续费、历史账期、会话查询、真实 webhook、完整第 2 步履约端到端均未通过实测。
- 两个预先存在的商品没有修改；六个新测试商品和本次财务对象保留供复核。49/496 的测试订阅仍可能按测试日程续费；
  69 已取消续费。没有自行删除测试账务或取消其他订阅。
- 浏览器仅本任务一个新窗口/标签，已关闭。官方 CUA 创建和状态读取均超时后，改用 CDP bridge 操作同一任务。
- 本地验证：六项签名/验签对照 PASS；脚本语法、代码大小、diff、凭据排查结果在 PR 最新交接评论。
- 必需 CI 和独立机器人审查以 PR 最终版本的 GitHub 检查/评论为准，不用首个文档提交的绿灯代替。

### Handoff

完成：六个测试商品；三笔成功测试付款；取消续费；未付过期页面；显式同键重放；
付款/订单分页/退款真实查询；SDK 包与签名策略对照。证据见本目录。
下一步：完成本证据 PR 审查和 CI；将第 4 节交总控；#791 独立处理查询字段与实现。
阻塞：退款终态及供应商未给出的历史账期/会话恢复契约。**不合并**。
