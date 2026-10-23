# PAY-REFUND：Stripe 年付及创始订阅首购退款

## 范围与接口

扩展现有订阅退款状态机和 SQL，不新增表、队列或任务。Stripe card / card_cn 年付、创始首购以及有明确原单关系的 Pro → Gold 升级，复用证据核验、报价、批准、source hold、幂等执行、webhook 和每日对账。

管理员接口（admin 权限）：

| 接口 | 输入与返回 |
| --- | --- |
| `quoteSubscriptionRefund`（query） | 与 `quoteMonthlyRefund` 相同；订单、工单、feePermitted、feeEvidence → terms/versionHash/localVersion/executable=false |
| `approveSubscriptionRefund` | 上述输入加版本信息 → 原有批准记录 |
| `executeSubscriptionRefund` | orderId + intentId → 原状态机进度；未知结果 review_required |
| `getSubscriptionRefundStatus`（query） | orderId → 当前批准记录或 null |
| `rejectSubscriptionRefund` | 与原月付拒绝接口相同 |

月付接口保留，二者引用同一 procedure。内部沿用 `monthly_first_purchase` 和 SQL/RPC 名称，避免另起状态机或破坏历史记录。可选 `terms.priorPro` 绑定升级前的订单、订阅、供应商引用和原到期日；客户端不能声明恢复范围或金额。原 Pro 的 `autoRenew` 一并冻结；一次性钱包来源的 providerSubscriptionId 必须为 null，invoiceId 保存它原有的 payment 引用，不伪造订阅。`renewalEvidence` 记录退款前后的 cancel_at_period_end。

首购申请以真实付款至原工单提交时间计算，最长 168 小时；付款后全账户用过积分、续费、未决扣费、付款/争议/映射不明一律不执行。手续费仅 confirmed 扣 6%；unknown 统一映射不扣，税仍全退。年付只锁定并扣回本单已经到账的月度发放，未发部分终止；保留其他来源。创始身份、徽章和展示墙资格使用原有退款状态派生，已售资格继续 sold，名额不返还。

退款仍先暂停续费，再退款并立即取消；失败核实后恢复原状态。最终读到 canceled 时使用供应商实际续费标记，不硬写 true；退款前 false 而最终仍 true 则转人工。旧 Checkout 回跳继续使用已合并 #1244 的已履约退款保护。本次每日对账也把自有批准退款交给原退款核验入口，弥补只收到 refund.updated 时跳过自有退款的缺口，不自动创建新退款。

Gold 升级退款后，仅恢复精确关联且仍在原付费期限内的 Pro，原到期日和停止续费状态保持；原 Pro 年付剩余发放继续，不自动恢复扣费。恢复前重新读取原 Pro 的 invoice payment → PaymentIntent → captured charge，复用退款/拒付保护；发票仍为 paid 但现金已退、待退或有拒付时转人工，不能恢复已失效的 Pro。

## 本地验证

- PASS：新增年付回归先在原实现复现 3 项失败，修复后通过。
- PASS：`node packages/db/tests/pay-waffo/run-local.mjs --quick --annual-only`：339 步文件建库成功，34 项主套件用例通过（随后原故障切换回归 50 项也通过）。包含 card_cn Pro 年付、Managed Payments Gold 年付含税、已用/超期拒退、真实年付续费拒退、创始下墙/身份撤销且 sold 保留、原银行卡及一次性钱包 Pro 恢复（微信月付、支付宝年付）、关闭账号不恢复等级、并发批准同一记录、重复完成只扣一次、pending 保持人工和金融擦除证明。
- PASS：原 Pro 已退款、拒付、待处理退款或 invoice payment 错绑四项回归在修复前失败，修复后通过；另覆盖原 Managed Payments 含税付款核验。
- PASS：单元回归覆盖真实执行循环的响应丢失后转人工，再从原退款读取恢复；重复执行只发送一次退款及取消。
- PASS：完整支付单元 82 文件 / 1372 项，另定向复核银行卡及钱包 Pro 的真实报价证据链；API 类型、lint、代码尺寸检查通过。
- PASS：原支付数据库主套件 245 项及故障切换回归 50 项（含原月付、Stripe 含税/无税及本机 live 模拟兼容）；没有访问正式环境。
- PASS：空库回放 339/339，270 次历史位置重复执行，结构指纹已刷新，清理 PASS。
- PASS：年付已发两个月仅扣回两期、并发执行只有一个 claim 成功；原月付恢复套件 12 组检查通过，含真实 TS 服务 + PostgreSQL 的停止续费/退款/取消超时恢复、现金冲突、晚到 webhook、关闭账号、失败恢复及擦除证明。
- 进行中：总控已分配0336；正在按正式编号重放、刷新指纹，CI 17/17 和最终版本机器人复核完成后交总控合并。

## 迁移兼容与恢复

正式迁移 `0336_pay_subscription_first_refund.sql`（总控10-23分配，原临时号9999）；本窗口不应用远程迁移。迁移使用有锚点的替换，保留后续 mode/拒付/锁保护；同一历史位置连续执行两次由空库回放验证。数据库先行，原月付接口、签名与无新增字段的批准哈希保持。旧应用遇到新年度/升级记录会保持原持久记录并等待新版处理，不删除/重建批准。

恢复采用追加迁移向前修复。不能通过回退代码撤销已经发送的退款，也不能删除 hold、流水或供应商引用；状态未知先读原供应商，再用同一 intent 和幂等键处理。现金成功尚未取消的保留人工状态，核实后使用同一执行接口完成取消及本地终止。只在确定失败后释放锁定积分和权益，原 Pro 不改期、不重开续费。

## 交接和真实验收

总控合并且正常部署后才运行；不部署分支、不手工改库、不伪造事件、不使用正式环境。后台前端由 Claude 另做。

1. 核对正常 staging 包含本 PR 及正式编号迁移。入口 `https://auth-staging.graylum.com`；运行 `node ~/.graylum/staging-login admin` / `user12`，只使用生成的 storageState，不读取或记录凭证。同一账号只运行本任务。
2. user12 仅用现有创始订单和工单 `TK-20261022-7AE492`。只读确认付款/税、支付首购性质、申请时间、全账户消费、原 Session 和实际 success_url、权益、积分、创始与展示墙资格、已售名额计数以及 Stripe/local cancel_at_period_end。前置不符即停止并记录，不创建替代订单。
3. 通过上述管理员接口报价、核对版本、批准并执行真实 Stripe 沙盒退款。所在地不能确定选 unknown（不扣费）；不能客户端给退款金额。响应未知即停并查询原状态，不重新批准或另开退款。
4. 等真实 webhook，核对 Stripe 原单退款状态和金额、本地同一 intent、会员结束、仅本单已发积分回收一次、未发年付终止、创始徽章/身份结束、墙资格移除且 sold/已售数不变。公开墙人数不足时分别报告资格移除与访客页面验证，不假造展示条目。
5. 保存退款后、回跳前的 Stripe 和本地取消标记；用原 Session 实际 success_url 回跳，等真实 syncCheckoutSession 响应/DOM 后再读两端。原 false 不能变 true，变化则转人工。再回跳一次查幂等，积分和退款次数不变。分别记录退款、权益/积分、创始、回跳结果。

真实验收当前 NOT_RUN；CI、本机模拟和临近账号不能替代 user12 的真实沙盒链路。

供应商契约核对：[取消订阅](https://docs.stripe.com/api/subscriptions/cancel)、[创建退款](https://docs.stripe.com/api/refunds/create)。


## 追加：一次性会员报价的已消费拒绝

Owner 10-22 要求同 PR 修复 #716 的 clean1 / TK-20261022-80556E。只读核对 staging：订单为 Stripe test 微信一次性会员、completed/paid；发放3480、consumed_amount=2，付款后存在 spend=-2，无未结算预扣，工单为同一账号 billing。没有再次请求线上报价、批准或执行，也没有使用浏览器。

原因有三层：原 SQL 将明确 spend 与未知负流水合并成 `PAY_REFUND_CONSUMPTION_OR_UNKNOWN`；服务包装为 `PAY_REFUND_RECHECK_FAILED`；一次性退款报价接口再包装通用500。新增迁移仅在原保护前精确识别付款后的全账户 `spend && amount<>0`，返回 `PAY_REFUND_CREDITS_CONSUMED`，原未知流水保护完整保留。

报价接口只解开自己的 RPC 包装，且仅接受 PostgreSQL P0001 的两个明确代码：已用返回 HTTP400 /“付款后用过积分，不符合退款条件”；旧数据库或未知流水返回 HTTP400 /“无法确认付款后的积分使用情况，请先核对账单”。其他异常仍安全返回500。结构化日志仅写安全代码，不写供应商/数据库诊断或用户输入；无需前端改动，现有错误展示直接显示中文原因。批准、执行及金额校验不变。

新增本机验证 PASS：HTTP 适配器连接真实管理员路由、现金证据读取和 RPC 包装；旧实现两项500复现，修复后消费/未知明确区分；未知数据库、供应商及伪装/缺失 SQL 代码不泄漏、不误判；成功报价结构与管理员允许/拒绝保持。真实 PostgreSQL 钱包与积分包报价测试：消费拒绝、正向返还不能抹去消费、余额/会员/批准不变，未知非管理员负数调整仍阻断。数据库回归在旧 SQL 复现旧合并代码，迁移后验证新代码。

新旧兼容：不改 RPC 签名/成功返回/持久状态；旧应用遇新拒绝仍不产生报价或退款，新应用遇旧合并拒绝不会谎报确定消费。恢复仍用追加迁移向前修复，没有本项引入的数据需要撤销。线上 clean1 页面复验等待总控合并正常部署，NOT_RUN；如需要浏览器，会先在本窗口说明。

本次最终验证：支付及管理员单元82文件/1372项；数据库主套件245项+故障切换50项；空库339/339、270次历史位置重复执行和指纹刷新、cleanup PASS；API类型/lint/尺寸/diff PASS。总控已分配0336；改号后的验证、最终版本机器人复核及CI17/17仍须重新确认。
