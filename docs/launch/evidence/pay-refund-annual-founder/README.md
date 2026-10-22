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

月付接口保留，二者引用同一 procedure。内部沿用 `monthly_first_purchase` 和 SQL/RPC 名称，避免另起状态机或破坏历史记录。可选 `terms.priorPro` 绑定升级前的订单、订阅、供应商引用和原到期日；客户端不能声明恢复范围或金额。`renewalEvidence` 记录退款前后的 cancel_at_period_end。

首购申请以真实付款至原工单提交时间计算，最长 168 小时；付款后全账户用过积分、续费、未决扣费、付款/争议/映射不明一律不执行。手续费仅 confirmed 扣 6%；unknown 统一映射不扣，税仍全退。年付只锁定并扣回本单已经到账的月度发放，未发部分终止；保留其他来源。创始身份、徽章和展示墙资格使用原有退款状态派生，已售资格继续 sold，名额不返还。

退款仍先暂停续费，再退款并立即取消；失败核实后恢复原状态。最终读到 canceled 时使用供应商实际续费标记，不硬写 true；退款前 false 而最终仍 true 则转人工。旧 Checkout 回跳继续使用已合并 #1244 的已履约退款保护。本次每日对账也把自有批准退款交给原退款核验入口，弥补只收到 refund.updated 时跳过自有退款的缺口，不自动创建新退款。

Gold 升级退款后，仅恢复精确关联且仍在原付费期限内的 Pro，原到期日和停止续费状态保持；原 Pro 年付剩余发放继续，不自动恢复扣费。

## 本地验证

- PASS：新增年付回归先在原实现复现 3 项失败，修复后通过。
- PASS：`node packages/db/tests/pay-waffo/run-local.mjs --quick --annual-only`：339 步文件建库成功，32 项用例通过。包含 card_cn Pro 年付、Managed Payments Gold 年付含税、已用/超期拒退、真实年付续费拒退、创始下墙/身份撤销且 sold 保留、原 Pro 恢复、并发批准同一记录、重复完成只扣一次、pending 保持人工和金融擦除证明。
- PASS：单元回归覆盖真实执行循环的响应丢失后转人工，再从原退款读取恢复；重复执行只发送一次退款及取消。
- 进行中：完整支付单元、原月付兼容、结构重复执行与指纹、CI 和机器人最终复核。尚不可合并。

## 迁移兼容与恢复

临时迁移 `9999_pay_subscription_first_refund.sql`，上库前找总控取得正式编号；本窗口不应用远程迁移。迁移使用有锚点的替换，保留后续 mode/拒付/锁保护；同一历史位置连续执行两次由空库回放验证。数据库先行，原月付接口、签名与无新增字段的批准哈希保持。旧应用遇到新年度/升级记录会保持原持久记录并等待新版处理，不删除/重建批准。

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
