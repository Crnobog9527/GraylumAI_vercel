# PAY-COMMON PR-3：后台渠道选择与订单投影

## 目标

管理员手动选择“新购买使用的渠道”，只影响新购买；旧订单、订阅及凭证保持原渠道。
Codex 完成服务端修复后停笔，主窗口复核后 Claude 接手同一分支完成后台及账单展示，再整体验证。

## 改动

风险 **high**：渠道设置影响支付准入，新增数据库触发器并修改购买事务。
复用 system_settings 和原购买 RPC；普通 upsert 无法同时保证渠道版本及下单竞争次序，
因此仅给渠道键增加版本保护，并由现有购买事务共享同一事务锁，不新增表或配置服务。
现有订单、渠道映射和账本继续权威。原退款、Waffo 接入及 BILL2 核心不变。

- 单项/批量保存都校验枚举及递增版本，混合批量仍单事务；不覆盖 runtime_rate_limits。
- 缺键统一 Waffo。Waffo 未接入，新购买明确拒绝，不能自动回落 Stripe。
- 新购买在锁内读取选择，原未决意图先恢复；原升级、续费、取消及凭证不读新默认。
- Stripe 目录仅测试模式可购买；新购买事务拒绝 live，不能借本 PR 开放正式收费。
- 年付异常进入原 cron 的数量和原因码摘要；Sentry 固定码
  PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED，仅发送数量和固定原因，不发送主体或供应商编号。
  正常订阅继续发放且重放不重复；数据库故障仍让整轮失败。

迁移为 **0173_pay_common_channel.sql**，0172 留给 #666；
以 #666 合入 staging 后的 runtime_view 定义为整库指纹基准。迁移不插入渠道设置、不访问外部支付系统。
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
  无后台读取权限、设置读取失败或无效时仍返回商品，paymentChannel=null 且不可购买；缺键仍为 Waffo。
- 本人 `payments.listBillingRecords()` 保留现有字段，增加 paymentChannel、paymentChannelLabel、
  paymentMode、documentSource、documentStatus（available/unavailable/unknown）、amountFacts。
  unknown 表示凭证暂时无法核实（含 Stripe 故障、不一致或缺客户端），unavailable 表示确认没有可用凭证。
  前端必须分开显示这两种状态，unknown 不可显示成“无凭证”。
  原 invoiceNumber / invoicePdfUrl / hostedInvoiceUrl / receiptUrl 继续可用，均按原订单查证。
- 管理员 `payments.listAdminOrders({ offset: 0, limit: 20 })`，limit 最大 50，返回 `{ items, total }`。
  items 包含 id、itemType、billingCycle、status、paymentStatus、amountMinor、currency、
  createdAt、fulfilledAt，以及上述渠道/凭证投影和四个凭证字段；不返回用户资料、商户标识或原始 metadata。
- amountFacts 是 `{ kind, amount: 精确十进制字符串 | null, currency, unit: 'major' }[]`。
  缺少费用/净额事实或 amount 为 null 都表示未知，不填 0；不暴露 evidence_ref。
  amountMinor 是原订单最小单位，不可把任意币种固定除以 100；本轮 Stripe 商品仍为 USD。
  documentSource 是原渠道，不是法定卖家名称；直接打开原凭证，不另造 Graylum 收据。

## 验证

PASS（本轮本机）：支付与设置定向 437 项，cron 请求/日志/Sentry 边界 3 项；
账号删除集成 5 项（包含 T09/T11）与随后开户积分回归 13 项；API/Web 类型检查、修改服务端及新增测试 lint、源码规模检查。
支付 SQL 全套、106 次历史位置重复检查、渠道切换/下单双顺序并发及原发放并发、临时库清理通过。
使用 #666 的 0172 定义组合建库：176/176 步、107 次重复、回滚与重放、指纹重建通过。
相比本 PR 原指纹仅新增 runtime_view 变化；0173 不修改 runtime_view，函数漂移校验无需更改。
最终同步后的 CI/Security 结果以 PR 交接为准。

NOT_RUN：本分支真实 Stripe 沙箱、前端浏览器、外部 Sentry 实际送达。本机 fixture 不代表沙箱通过。
本窗口不访问远端数据库、不改外部配置、不合并；不能单独部署服务端切片。

## 审查

主窗口中途审计 PASS；本轮按评论 5993975972 修复，等待主窗口复核。
中途审计及旧版本检查不等于最终候选已通过；前端完成后仍需最终候选的完整验证。

## 发现的问题

本轮测试夹具需显式选择测试 Stripe，旧夹具的隐式 Stripe 假设已移除；修正夹具类型及新增字段断言。
未改变历史支付规则以迁就测试。
账号删除本机首轮出现 SQL 复合返回值取值错误，修正为直接选择 id 后 T09/T11 通过。
额外对旧 payments.test.ts 全文件运行 ESLint 发现既有 any 规则违规；未扩大到历史测试清理，
新增凭证测试已独立并通过 lint，项目最终 CI 状态另记。
首轮 CI 空库后的支付 SQL 因未显式选择测试 Stripe 被缺省 Waffo 拒绝；
各相关 SQL 夹具已改为在自身回滚事务内选择 Stripe，保持真实默认保护。
最终 CI 状态以 PR 交接为准，首轮失败不能记为通过。

## 上线后再看

P3-2：将新增渠道 SQL 回归纳入 CI；本轮先保留本机全套验证。
P3-4：后台订单列表逐行查询 Stripe 的性能优化，按实际流量评估批量/缓存方案。
实际 Sentry 投递待验证。PR-2 原有缺渠道年付记录、扫描窗口及退款交接继续归原任务，不扩展本切片。

## Handoff

已完成：服务端接口与迁移、订单投影、年付告警、本机验证主体。
下一步：服务端修复完成，等待主窗口复核。主窗口复核前暂缓前端交接；确认后 Claude 接手同一分支。
前端接手前不可同时写本分支；前端完成后补全候选回归和浏览器验证。
整体上线顺序：后台和读取一起到位，迁移经批准应用后，由管理员在 staging 保存 Stripe 并读回，
再验证测试购买；保存前因默认 Waffo 暂停新购买是预期。既有订单处理不能被此暂停影响。
阻塞：前端和本分支沙箱验收未完成，当前不是可合并的完整 PR。
