# PAY-COMMON PR-3：后台渠道选择与订单投影

## 目标

管理员手动选择“新购买使用的渠道”，只影响新购买；旧订单、订阅及凭证保持原渠道。
Codex 完成服务端后停笔，前端接手同一分支完成后台及账单展示，再整体验证。

## 改动

风险 **high**：渠道设置影响支付准入，新增数据库触发器并修改购买事务。
复用 system_settings 和原购买 RPC；普通 upsert 无法同时保证渠道版本及下单竞争次序，
因此仅给渠道键增加版本保护，并由现有购买事务共享同一事务锁，不新增表或配置服务。
现有订单、渠道映射和账本继续权威。原退款、Waffo 接入及 BILL2 核心不变。

- 单项/批量保存都校验枚举及递增版本，混合批量仍单事务；不覆盖 runtime_rate_limits。
- 缺键统一 Waffo。Waffo 未接入，新购买明确拒绝，不能自动回落 Stripe。
- 新购买在锁内读取选择，原未决意图先恢复；原升级、续费、取消及凭证不读新默认。
- Stripe 目录仅测试模式可购买；新购买事务拒绝 live，不能借本 PR 开放正式收费。
- 年付异常进入原 cron 的 anomalies 摘要；Sentry 固定码
  PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED，仅发送数量和固定原因，不发送主体或供应商编号。
  正常订阅继续发放且重放不重复；数据库故障仍让整轮失败。

迁移暂为 **0172_pay_common_channel.sql**，接在当前 staging 最大编号 0171 之后；
与并行 BILL-PAYG 按实际合并顺序顺延。迁移不插入渠道设置、不访问外部支付系统。
包含购买函数及触发器函数漂移拒绝；本机历史位置重复执行并更新 built 指纹。
恢复使用 Waffo 停止新销售后前向修复，保留订单/映射/发放；不能删账或切默认冒充退款。

## 前端接口

- `settings.getPaymentChannel()`：管理员读取 `{ channel: 'waffo' | 'stripe', version }`。
  缺键返回 Waffo/version 0；读失败或非法值返回安全错误，不能显示默认成功。
- `settings.updateSystemSettings({ key: 'payment_new_purchase_channel', value: { channel, version: 当前版本 + 1 } })`。
  批量接口 `settings.updateSystemSettingsBulk([...])` 使用相同项；过期版本返回 CONFLICT，
  需刷新后由管理员重新保存，不自动重试覆盖。保存后重新读 getPaymentChannel。
  界面标签“新购买使用的渠道”，注明“只影响新购买”；Waffo 显示未接入。
- 目录 `settings.getCreditPackages/getMembershipPlans` 增加 `paymentChannel`；沿用
  checkout_ready / checkoutReady 控制按钮。当前选择和实际购买就绪必须分开显示。
- 本人 `payments.listBillingRecords()` 保留现有字段，增加 paymentChannel、paymentChannelLabel、
  paymentMode、documentSource、documentStatus（available/unavailable/unknown）、amountFacts。
  原 invoiceNumber / invoicePdfUrl / hostedInvoiceUrl / receiptUrl 继续可用，均按原订单查证。
- 管理员 `payments.listAdminOrders({ offset: 0, limit: 20 })`，limit 最大 50，返回 `{ items, total }`。
  items 包含 id、itemType、billingCycle、status、paymentStatus、amountMinor、currency、
  createdAt、fulfilledAt，以及上述渠道/凭证投影和四个凭证字段；不返回用户资料、商户标识或原始 metadata。
- amountFacts 是 `{ kind, amount: 精确十进制字符串 | null, currency, unit: 'major' }[]`。
  缺少费用/净额事实或 amount 为 null 都表示未知，不填 0；不暴露 evidence_ref。
  amountMinor 是原订单最小单位，不可把任意币种固定除以 100；本轮 Stripe 商品仍为 USD。
  documentSource 是原渠道，不是法定卖家名称；直接打开原凭证，不另造 Graylum 收据。

## 验证

PASS（本机当前）：原支付/设置/年付定向 303 项；新增及支付模块定向 237 项（范围有重叠，不能相加）；
cron 请求和 Sentry 边界 3 项；支付 SQL 全套、175/175 空库步骤、106 次重复执行、
渠道切换/下单双顺序并发及原发放并发、独立 built 指纹重建、临时库清理。
全量 API、类型、lint、CI/Security 的最终结果在 PR 更新。

NOT_RUN：本分支真实 Stripe 沙箱、前端浏览器、外部 Sentry 实际送达。本机 fixture 不代表沙箱通过。
本窗口不访问远端数据库、不改外部配置、不合并；不能单独部署服务端切片。

## 审查

服务端独立审查待最终候选稳定后执行。全 PR 前端完成后仍需覆盖最终候选的独立审查。

## 发现的问题

本轮测试夹具需显式选择测试 Stripe，旧夹具的隐式 Stripe 假设已移除；修正夹具类型及新增字段断言。
未改变历史支付规则以迁就测试。

## 上线后再看

实际 Sentry 投递待验证。PR-2 原有缺渠道年付记录、扫描窗口及退款交接继续归原任务，不扩展本切片。

## Handoff

已完成：服务端接口与迁移、订单投影、年付告警、本机验证主体。
下一步：完成当前检查和服务端审查后，明确“服务端完成，交前端”并停笔。
前端接手前不可同时写本分支；前端完成后补全候选回归和浏览器验证。
整体上线顺序：后台和读取一起到位，迁移经批准应用后，由管理员在 staging 保存 Stripe 并读回，
再验证测试购买；保存前因默认 Waffo 暂停新购买是预期。既有订单处理不能被此暂停影响。
阻塞：前端和本分支沙箱验收未完成，当前不是可合并的完整 PR。
