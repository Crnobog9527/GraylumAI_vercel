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

## 前端（Claude 接手同一分支）

写入方已从 Codex 换成 Claude（Codex 原工作区无未上传改动）。用 merge 同步 staging（含 #666 的 0172），未 rebase、未强推。
本节只把上面「前端接口」写成界面，不改服务端规则；新文案已由主窗口审过。

- 后台「系统设置 → 计费」新增「新购买使用的渠道」：显示当前选择，和「实际可以购买」的积分包/会员套餐数量分开显示。
  保存提交 `{channel, version: 读到的版本 + 1}`；CONFLICT 时提示重新读取并锁定编辑，不自动重试；保存后重新读取确认。
  读取失败或值无效显示错误、不能选择或保存，不会显示成默认值。Waffo 标注未接入，选它会暂停新购买。
- 后台新增「支付订单」页（侧栏在「交易记录」下）：listAdminOrders 每页 20（不超过 50），只显示接口返回的字段；
  金额按币种最小单位换算（不固定除以 100），缺失显示未知；实付/渠道手续费/到账净额缺失时显示未知。
- 用户「账单记录」：显示支付渠道和凭证状态；「凭证暂时无法核实」（unknown）和「没有可用凭证」（unavailable）文字和颜色不同，
  unknown 不出现“没有凭证/无凭证”字样；用户只看标价/优惠/税费/实付/已退款，金额为 null 显示未知。
  读取失败显示错误而不是“暂无账单记录”；原来写死的 Stripe 文案改为通用。
- 价格页和购买卡片：沿用 checkout_ready / checkoutReady；渠道为空或 Waffo 时照常显示、不可购买（新增测试）。

## 验证

PASS（本轮本机）：支付与设置定向 437 项，cron 请求/日志/Sentry 边界 3 项；
账号删除集成 5 项（包含 T09/T11）与随后开户积分回归 13 项；API/Web 类型检查、修改服务端及新增测试 lint、源码规模检查。
支付 SQL 全套、106 次历史位置重复检查、渠道切换/下单双顺序并发及原发放并发、临时库清理通过。
使用 #666 的 0172 定义组合建库：176/176 步、107 次重复、回滚与重放、指纹重建通过。
相比本 PR 原指纹仅新增 runtime_view 变化；0173 不修改 runtime_view，函数漂移校验无需更改。
最终 CI/Security 受前置依赖阻塞：#666 的 0172 尚未进入 staging。
当前分支使用 0173，built 指纹已经包含 #666 的 runtime_view 定义；必须待 #666 合入后再 merge staging 并验证。
当前分支缺少 0172，不能把临时目录组合建库通过当成当前分支 CI 通过。

NOT_RUN：本分支真实 Stripe 沙箱、前端浏览器、外部 Sentry 实际送达。本机 fixture 不代表沙箱通过。
本窗口不访问远端数据库、不改外部配置、不合并；不能单独部署服务端切片。

前端（Claude，本机）：web 类型检查、改动文件 lint、源码规模检查通过；新增/修改的 web 单元测试 32 项通过
（展示逻辑、后台渠道设置浏览器级测试：保存读回、CONFLICT 不重试、读失败/非法值；账单 unknown/unavailable；订单分页；价格页渠道为空/Waffo）。
web 全量单元测试本机 113 个文件通过；2 个未改动的浏览器测试文件只在全量并发时 afterAll 超时，单独运行通过，以 CI 为准。
合并 staging 后重建 built 指纹：无差异（已包含 0172 runtime_view 和 0173 对象）。
NOT_RUN：staging 真实浏览器和 Stripe 测试模式购买 —— 需要主窗口先应用 0173 并合并后，按 Validation handoff 由 Codex 执行。

## 审查

主窗口中途审计 PASS；服务端修复增量主窗口复核 PASS（评论 5995999915）。
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

写入方：Claude（同一分支；Codex 已停笔）。
已完成：服务端（Codex）+ 前端（Claude）；已 merge 最新 staging（含 #666/0172）；本机检查见「验证」。
下一步：完整 CI 通过后转 ready，等审查机器人；P0/P1 在新版本上修复。
合并后：主窗口应用 0173 → Codex 按 PR 里的 Validation handoff 评论在 staging 做浏览器 + Stripe 测试模式验收。
保存 Stripe 之前，staging 因默认 Waffo 暂停新购买，这是预期。
未验证：staging 浏览器、Stripe 沙盒购买、Sentry 实际送达。不应用迁移、不改配置、不合并（由主窗口负责）。
