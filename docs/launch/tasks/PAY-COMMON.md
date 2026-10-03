# PAY-COMMON 实施方案（high，仅方案）

状态：待总控独立审查；本次只新增本文，不实施代码、迁移、远程数据库访问、支付调用或外部配置。
PAY-WAFFO 不在本次范围。方案通过也不等于实施、迁移应用、渠道启用或合并批准。

## 1. 结论与范围

复用现有商品、订单、订阅、积分发放和唯一账本，逐步把 Stripe 特定输入隔离在支付服务边缘。
后台提供 D17 的“新购买使用的渠道”（Waffo / Stripe，手动切换），订单先冻结成交渠道；
已有订阅的升级、续费、取消、退款、凭证和未决结果核对始终按原渠道。
不新增钱包、通用支付平台、运行引擎、队列、调度器或第二份会员事实。

关键限制：现有积分来源 SQL 仍通过 Stripe 订阅标识连接。PAY-COMMON 可以交付公共购买契约、
Stripe 兼容路径和后台渠道设置，但不能据此宣布 Waffo 已可收费。跨渠道来源保护的实际接线
须由总控安排后续授权切片，与 BILL-PAYG 协调；本任务不改 BILL2 核心。

依据（均已读取）：

- 当前 [AGENTS.md](../../../AGENTS.md) §1–9、12–13 与 [ENGINEERING.md](../../ENGINEERING.md)。
- [MASTER_PLAN](../MASTER_PLAN.md) §7.1、§10 D17 / 待决事项、§11；[v11](../Graylum_Master_Plan_v11.md) §9。
- [ENTITLEMENTS](ENTITLEMENTS.md) §5–8：已定权益、取消后保留原期、状态不确定拒绝新付费动作。
- [DATA-ERASURE](DATA-ERASURE.md) §2–4、§9 E4/E5；[BILL-PAYG 当前方案](https://github.com/Crnobog9527/GraylumAI_vercel/pull/553)。
- [2026-10-03 总控授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/594#issuecomment-5965897528)：
  钱路线由 Codex 出方案；ENTITLEMENTS PR-2 后台前端由 Claude 另做。本次不代做该 PR。

## 2. 核对基线与写入协调

2026-10-03 通过 gh/git 核对公开仓库、staging、全部 open PR 文件以及相关本地 worktree。
起点为 staging `34017395f1e184bfa3645c51cb7ef55fed2bdae4`；下节源码行号全部绑定此提交，
不是远程数据库或运行环境验证。已读取目标分支保护和现有 CI/Security 工作流：PR 运行完整
本地测试环境检查，未发现工作流部署或支付步骤；本任务只触发已有 PR 自动化。

本次实际写入仅 `docs/launch/tasks/PAY-COMMON.md`。实现候选范围限会员计划、订阅、
支付订单、渠道及其后台和个人中心支付组件；不改 Runtime、BILL2 核心、定位、选题、工作区。

| 在途 PR / head（核对时） | 全部文件核对结果及后续交界 |
| --- | --- |
| #606 / `9f9a7e6ea8d9a3fc5755764dc918ac9b206e2d64` | 21 文件：模型后台、个人中心及安全提示；`SubscriptionCard.tsx` 与未来支付入口重叠，先由总控安排交接 |
| #605 / `51400ba1c79bb214e538c9090d76d8c300109830` | 6 文件：部署、Stripe 启用清单、账务日志及运行手册等旧域名文档；本文无重叠，沙箱验证入口沿其最终结论 |
| #604 / `dbdc55b60ea1b3acf8e4854a9459cd05ce5b97f4` | 1 文件：对话原生体验方案，无本文重叠 |
| #603 / `8bb2eab3c501dcb5ddec7a5d52b13ab525948c5f` | 4 文件：OPC 测试、schema fixture、API lint 基线、DB 测试入口；未来共同测试入口需排队 |
| #602 / `25d751c90aa1c2eb349a0cb9b096da5821bded0b` | 1 文件：OPC integration；不触碰 |
| #601 / `4c0c52a78b5a838313b1b3735fe945d09944aeae` | 1 文件：缓存方案；无本文重叠 |
| #598 / `001d8b4450cf8760f3a455f23d663c190ae76780` | 1 文件：注销在途账务方案；未来退款/封闭主体收尾有语义交界，由总控先定前后顺序 |
| #594 / `e2305a4b63896a84945e51dc6c1f545b93db4844` | 61 文件：RATE-LIMIT、Runtime、OPC、后台限流组件、测试及大小基线；不动业务文件，未来共享基线/测试入口协调 |
| #593 / `fd210532e83c3299067ce2064bff4d2879a1f48b` | 20 文件：采集、Runtime、0159、built 指纹、测试入口及大小基线；后续迁移编号/指纹必须串行 |
| #590 / `9874815eff595db40b55558c26833a39707fa7d4` | 47 文件：RATE-LIMIT/Runtime 与大小基线；不动其业务文件 |
| #553 / `135d4c197a630e613ea692c0fe9742079e295869` | 当前 base-to-head 0 文件，方案在 PR 描述；BILL-PAYG 的来源预留/释放由该 writer 负责，不能把空 diff 当作完成 |
| #547 / `8fb950af3a95e1d40f3053f1b76c1bbea7486bcd` | 当前 0 文件，报告方案；本次不接线 |

本地另有 Claude 后台小修补已修改个人中心 `profile/page.tsx`、`SubscriptionCard.tsx`、
积分记录与模型后台组件，初次核对时尚无 PR，push 前已见 #606 并核对全部 21 文件；未来付款入口改动须等其交接。
ENTITLEMENTS PR-2 预定修改 `admin/settings/page.tsx` 及会员控件，与渠道设置容器有明确重叠：
先交付 PR-2，再由 PAY-COMMON 复用最终容器；不靠各自 worktree 同时写同文件。
历史 payment-channels worktree 是 D17 文档提交，无未提交修改；未发现本文已有 writer。
旧域名清理任务可能修改 Stripe URL 读取或测试，实施前刷新其最终文件清单并由总控排队。
以上是核对时快照；每次实现、push 前刷新相关 writer 和 open PR 差异。

## 3. 现状盘点（源码证据，不等同已部署）

下表链接使用固定提交。表结构须由 baseline 加全部追加 migrations 推导，不能只看建表版本。

| 能力 | 代码 / 表与当前行为 |
| --- | --- |
| 商品与唯一余额 | [baseline:31–43](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/baseline/0000_core_prerequisites.sql#L31-L43) 的 `profiles`；[95–110](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/baseline/0000_core_prerequisites.sql#L95-L110) 的 `credit_transactions` / `system_settings`；[144–156](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/baseline/0000_core_prerequisites.sql#L144-L156) 的 `credit_packages`；[261–280](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/baseline/0000_core_prerequisites.sql#L261-L280) 的 `membership_plans`。计划的价格、积分与权益继续用原表；0153 约束一等级一计划并补 Fusion/存储权益 |
| Stripe 订单、订阅 | [0012:4–48](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0012_stripe_payments.sql#L4-L48)：商品 Stripe price 字段；`payment_orders` 有 checkout/invoice 唯一 ID、金额、币种、状态、metadata；`user_subscriptions` 有 Stripe ID、周期、取消标志。订阅 Stripe ID 非空，现有结构不能直接存 Waffo。0043 统一订单状态，0152 补结构约束；没有独立多渠道设置/来源映射 |
| 商品可购买投影 | [settings.ts:330–439](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/settings.ts#L330-L439)：公开目录根据 Stripe 配置和 price 判断 checkout_ready；渠道切换后必须改为服务器按所选渠道的就绪结果，不能只换后台显示 |
| Checkout | [payments.ts:1412–1838](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L1412-L1838)：认证后读商品、价格和购买许可；积分包折扣和订阅周期由服务端决定。先调用 Stripe 再 insert 订单（1630–1651、1775–1806），新购买缺少先落本地身份的事务边界；本方案补齐它 |
| 购买 / 升级许可 | [membershipEligibility.ts:365–503](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/membershipEligibility.ts#L365-L503)、[529–764](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/membershipEligibility.ts#L529-L764)：`profiles`、订阅与最近会员订单合并判定；识别 active、取消续费、欠费、退款、冲突和 admin_override。Stripe 标识参与分类。`allowed` 是购买/变更许可，不能当功能使用许可 |
| 升级、取消 | [payments.ts:827–1040](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L827-L1040)、[1197–1240](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L1197-L1240)、[1290–1410](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L1290-L1410)：升级报价和恢复锁、full-target/no-proration；原已付发票负责权益履约。门户核对归属、允许期末取消、禁止门户改套餐；升级不暗中恢复续费 |
| 回调 / 返回页 | [webhook:25–122](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/apps/web/src/app/api/stripe/webhook/route.ts#L25-L122) 验签分发 checkout、invoice、refund、subscription；[payments.ts:1840–2017](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L1840-L2017) 返回页读远端会话并核对归属后走履约。订阅状态事件本身不应发积分 |
| 积分包发放 | [stripeFulfillment.ts:2186–2236](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/stripeFulfillment.ts#L2186-L2236) 调 `atomic_fulfill_credit_package`；[0035:5–95](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0035_fix_payment_fulfillment_rpc_ambiguity.sql#L5-L95) 锁订单/主体，余额与流水同事务，fulfilled 防重。当前 RPC 在履约时读现价目表积分，需冻结购买快照以避免支付期间编辑商品改变发放 |
| 会员与年付发放 | [subscriptionCreditGrants.ts:317–489](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/subscriptionCreditGrants.ts#L317-L489)、[2932–3060](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/subscriptionCreditGrants.ts#L2932-L3060)、[3189–3288](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/subscriptionCreditGrants.ts#L3189-L3288)。`subscription_credit_grants` 见 [0045:13–81](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0045_subscription_credit_grants.sql#L13-L81)；0053 加 consumed/termination，0054、0055 修正发放 RPC。年付原 UTC 锚点 12 月释放、月末 clamp，webhook/cron 共用发放；当前仍读取计划积分，后续需周期快照 |
| 退款与来源保护 | [stripeFulfillment.ts:2238–2320](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/stripeFulfillment.ts#L2238-L2320) 及其后退款事件核对；[subscriptionCreditGrants.ts:1748–1845](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/subscriptionCreditGrants.ts#L1748-L1845) 调 `atomic_refund_termination_clawback_fresh`，当前函数实现见 [0060:431–548](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0060_refund_1b_post_merge_forward_repair.sql#L431-L548)；[3503 起](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/subscriptionCreditGrants.ts#L3503) 有 operator preview。存在退款结果对账与积分回收，未查到产品路由主动创建货币退款，不应声称已有自动退现金按钮 |
| BILL2 交界 | [0061:103–198](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0061_refund_1b_expired_quarantine_repair.sql#L103-L198) 的来源选择以 `stripe_subscription_id` 连接订阅与 grant。保留 consumed 上界、quarantine、reversed、termination 和原来源释放；仅给 Waffo 增列并不能使计费核心兼容 |
| 当前功能权益 | [membershipEntitlements.ts:23–100](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/membershipEntitlements.ts#L23-L100) 复用上述事实、读取会员配置，正常/期末取消/admin_override 可用；冲突、欠费、退款核对按既定规则降为 free 投影；读取失败报错，封闭主体拒绝。下架只停止销售，不撤销已付权益 |
| 管理设置 / 页面 | [settings.ts:269–325](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/settings.ts#L269-L325) 已有单项/批量管理员设置；[admin/settings:516–620](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/apps/web/src/app/admin/settings/page.tsx#L516-L620) 是待 Claude 改的会员容器；[SubscriptionCard:292 起](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/apps/web/src/components/profile/SubscriptionCard.tsx#L292) 用 payments 路由。复用这些表单与安全提示，不另建后台 |
| 凭证与财务 | [payments.ts:1088–1173](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L1088-L1173)、[2027 起](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/payments.ts#L2027) 读 Stripe invoice/receipt，限定自己的订单；[admin.ts:2197–2210](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/routers/admin.ts#L2197-L2210) 读订单财务统计。后台不能把 credit refund 流水等同现金退款 |
| 开户 / 邀请 / 注销 | [trpc.ts:163](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/trpc.ts#L163) 调 `opening_grant_claim`；[0151:6–36](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0151_opening_grant_identity_digests.sql#L6-L36)、[127–144](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0151_opening_grant_identity_digests.sql#L127-L144) 保留赠送摘要；[0154:8 起](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/db/migrations/0154_invitation_claim_eligibility.sql#L8) 的邀请资格与唯一领取；[erasure service:49–99](https://github.com/Crnobog9527/GraylumAI_vercel/blob/34017395f1e184bfa3645c51cb7ef55fed2bdae4/packages/api/src/services/accountErasure/service.ts#L49-L99) 调原注销 RPC，续费中拒绝。不得用支付履约重发这些奖励 |

## 4. 最小正确改动与数据契约

### 4.1 复用与必要新增

| 现有机制 | 最小缺口与建议；权威归属 |
| --- | --- |
| 商品两张表 | 保留内部 UUID、价格/积分/会员配置；不新建 catalog 或权益表。每次购买把服务端商品版本、价格、币种、税处理、折扣、月/年积分及赠送写入订单不可变快照；功能开关仍读 ENTITLEMENTS 的当前配置 |
| `system_settings` | 增加一个严格枚举设置 `payment_new_purchase_channel`，缺省 `waffo`。单项/批量写走同一校验、管理员权限与并发版本检查；不另造配置服务。只记录选择，不保存凭据 |
| `payment_orders` | 增加渠道、非敏感商户命名空间、测试/正式模式、购买请求幂等键/负载摘要、冻结购买快照、关联订阅内部 ID、关联原始购买订单及必要精确金额事实。现有 metadata 存小型尝试状态与退款审批引用；冻结字段与可更新核对状态分开，禁止整对象覆盖 |
| `user_subscriptions` / `subscription_credit_grants` | 沿原表补通用内部订阅关联和渠道事实，原 Stripe 字段保留兼容；周期商品快照和年付总额随首次权威付款固定。不重建会员真相或积分来源表，不改既有 grant UUID / 幂等键 / 余额 |
| Stripe 单渠道外部字段 | 建议仅一张窄用途 `payment_provider_refs` 映射表：内部商品/订单/订阅/退款目标对应外部对象，唯一键含 channel、merchant namespace、environment、object type、external ID。现有列不能表示同商品不同周期/环境的多个 price，也不能约束跨类型/商户冲突；JSON 无法可靠承担这些外键与唯一性，因此这一张关系表是必要新增，不是支付平台 |
| 现有支付函数和 RPC | 先同目录局部拆出 Stripe 输入校验/规范化与公共履约调用；保留原入口兼容。在原订单创建/发放事务能力上做小型扩展，只在“先落单”确实没有原子入口时加一个支付局部 RPC；不建通用 workflow/RPC 家族 |

映射表只维护来源定位，不持余额或会员状态；引用类型须 CHECK 与实际外键保证，不允许任意
字符串指向不存在的内部对象。商品、订单、订阅各自原表仍权威。服务端写入，普通用户不能
直接读取商户命名空间或修改映射；用户接口只返回自有订单的渠道、金额、状态和受控凭证。
历史 Stripe 字段和新映射过渡期由同一事务写入并校验一致；不允许两套独立写入口。

金额拆分保存标价、优惠、税、实付、已退款、渠道费、净额，每项有币种、精度/单位和证据来源。
用数据库 NUMERIC / 精确十进制，缺少渠道费写 unknown，不能用 0 代替；不通过净到账反推积分。
不能把原 `amount_total` 整数分直接解释成任意币种小数。PAY-WAFFO 再核验其实际货币契约。
付款事实及冲突观测按外部身份追加到原订单受控证据字段，由锁内去重，不能覆盖旧证据或正文快照。
本版不新增事件总线或通用事件表；若实现证实字段无法满足原子性/容量，先在本方案范围内说明
具体最小缺口并审阅调整，不能默默扩成新基础设施。

### 4.2 D17：新购买渠道和原订单渠道

- 后台标签就是“新购买使用的渠道”；显示当前选择、可用/未接入状态，以及“只影响新购买”。
  提供 Waffo / Stripe 两个选项，保存后刷新从服务器读回；失败不显示成功。切换须管理员明确操作。
- 缺省 Waffo 是已定产品方向。本期 Waffo 尚未接入，选择 Waffo 时新购买安全拒绝并提示暂不可购买；
  不能伪造可用或悄悄退回 Stripe。测试需要 Stripe 时，仅在获准沙箱配置后由管理员手动选择。
  方案/代码合并不自动改已有外部配置，不自动开放收费；D8 封闭内测仍只用赠送积分。
- 选择与就绪分别判断：凭据存在不证明商户准入、条款、回调、商品映射和真实支付链路已验证。
  Waffo 就绪在 PAY-WAFFO 验收前固定 false。首次正式 Stripe 直收仍须 Owner 确认卖家/税务责任和上线授权。
- 服务器创建购买意图时锁内读取当前渠道并冻结商品快照；同请求重复使用原订单，切换与下单有确定提交顺序。
  客户端不能传入渠道覆盖设置。读取失败、未知设置、无有效商品映射均拒绝创建支付。
- 设置改变之后，旧 checkout 返回页、在途支付、既有订阅升级/续费/取消、退款和凭证都由存储的原渠道选择。
  对已有订阅升级按原订阅渠道；不能借“新购买”建立另一渠道重复订阅。
- 同一购买意图不跨渠道重试。超时、断线或结果未知保留原订单/尝试身份，先按原渠道查明；没有可靠查询能力
  就留待核对，不能认定失败重扣。已确认终止的意图若重新购买须显式新意图，仍不能绕过会员重复购买检查。

### 4.3 下单、履约、续费与幂等

1. 认证及账号可用检查、服务端商品/价格/购买资格判定；原子写入本地订单、不可变快照和唯一请求身份，
   同 key 同 payload 返回原状态，不同 payload 拒绝。再通过冻结渠道派发，网络调用期间不持数据库锁。
2. 复用该订单产生的稳定渠道幂等键。外部成功但本地回写失败、回调先于回写、双击和并发均从原订单恢复；
   既无回执又不能可靠查明时只显示核对中，不新建尝试或换渠道。外部 ID 不以本地 UUID 冒充。
3. Stripe 适配边缘验签，并按需要读取权威对象，核对主体、商户/模式、对象类型、商品、币种、应付/实付和周期。
   浏览器返回参数不作为付款证明；签名正确但金额/归属不符仍拒绝履约并记录冲突。
4. 付款去重按渠道命名空间内交易/发票身份；权益去重按内部订阅、原周期、grant 类型分别约束。
   invoice.paid 与 payment_succeeded 同笔不同事件、返回页与回调竞争也只履约一次。
   订阅状态通知只更新生命周期，不因 active 重发积分。迟到 pending/failed 不覆盖已成交/已退款终态。
5. 新购买积分按冻结快照发放；每次新续费周期由服务端在收费前固定该周期合同，回调不读已被编辑的当前商品重算。
   既有订阅按原合同续费，不因管理员改目录重定价；付款时才首次发现的周期须由可信原订阅合同/渠道事实重建，
   缺证据先核对，不能猜。年付一次冻结总额和 UTC 原锚点，十二期余数分配、月末 clamp 不变。
6. 原订单、grant、余额/流水更新保留原子性和锁序；profile 等级更新失败不得仍向用户报告权益完成。
   利用既有恢复分支重复完成未完成步骤，终态、会员事实和 grants 必须收敛一致。
7. 原年付 cron 继续按渠道与内部订阅读同一份发放事实，不增加 cron；取消续费不提前终止已付当期。
   部分/全额退款后的 termination、未来年付停止和原来源回收规则保持；既有 refund reconciliation 始终保留。
8. 凭证展示原渠道和法定卖家来源，同笔收款不再开一张 Graylum 收据；未知/不可用凭证清楚显示，不能跳到当前默认渠道。

## 5. 与其他任务的边界

### ENTITLEMENTS

PAY-COMMON 负责付款成交、生命周期和原渠道事实；ENTITLEMENTS 负责当前等级的功能配置/新动作判定。
扩展 `membershipEligibility` 的 Stripe 专用事实分类为显式 channel-aware，但保持购买动作语义；
`membershipEntitlements` 继续复用它，不复制一套权限。未知渠道/映射冲突不得被误识别成 admin_override。
支付恢复后新动作重新读权益；欠费、付款未完成、退款待核对不隐含宽限期。正常期末取消保留已付期限。
管理员合法赠予等级与真实支付订阅分别保留，管理员拒绝/冲突仍按既有规则，不用交易成功覆盖 Owner 拒绝。
已准入执行沿原冻结权益完成；新增动作才受变更影响；账号封闭等安全约束仍优先。
本期只测支付与权益接口，不修改消费者 Runtime；真实宿主并发证明由对应任务补齐。

### DATA-ERASURE 与退款

- 已定：账务最小必要字段从对应交易年度结束起保留 3 年；未决账务隔离核对，正文按既定时限删除。
  新快照/映射只留核对必要内容，不加入身份原文或支付工具信息，不把供应商原始 webhook 永久整包存储。
- 已定 E4：自动续费中拒绝注销，先由用户在原渠道取消并确认；不新增“注销时自动取消订阅”调用。
  二次确认后封闭主体，剩余积分使用权终止但原余额数字留作对账，不强制清零，不恢复登录。
- 已定 E5：订阅和积分包付款成功后默认不退款，Owner 可逐笔批准人工例外；方案不是任何一笔退款授权。
  “默认不退款”限制发起现金退款，不允许忽略支付商已经发生的退款/争议事件，也不取消已确认失败未交付
  的 BILL2 预留释放/积分退还。现金退款和 AI 调用积分恢复必须在名称与证据中区分。
- 推荐衔接见 §8 P1：不新增自助或自动现金退款入口；人工批准后沿原渠道处理、复用已存在的核对/回收。
  结果未知先查原交易，不再扣/退。部分与全额退款继续终止相关订阅的未来释放，仅回收适用订阅来源未用部分；
  不动开户、签到、管理员、积分包和其他订阅来源，也不能用退款额比例直接改总余额。
- 当前确认的退款代码重点覆盖会员订阅。积分包人工例外不能冒充已具备相同来源回收能力：本期不提供新执行按钮；
  具体例外若无法在现有来源证据下安全处理，保留人工核对状态，另列同范围技术设计及逐笔批准，不能借用订阅 RPC。
- 注销后仍可能收到权威付款/退款事实：必须记录原订单并保持封闭，不借履约复活会员使用权或自动退款。
  与 #598 的未决账务/保留规则由总控先统一；本期不改 erasure 控制器或 Runtime 收尾。

### 开户赠送、邀请奖励与 BILL-PAYG

沿用 `opening_grant_claim`、身份摘要、`atomic_claim_invitation_code`、原唯一账本及来源。
邀请只针对首次正金额开户赠送的新主体、每个主体一次绑定；不开消费返利。购买、续费、渠道切换、退款或重放
均不触发第二次开户/邀请奖励。开户 100、邀请 50/30、会员/积分包数值不因 q/m 改动自动重算。

BILL-PAYG 负责逐调用冻结、余额封顶、实扣与平台承担；PAY-COMMON 只增加经过验证的可用积分/来源事实，
不派发或恢复 AI 调用，不改 q=100、默认 m=3 或模型覆盖，不重写旧运行快照。充值后按原断点恢复由原 Runtime
与 BILL-PAYG 执行。消费中并发退款必须保留原期 consumed、quarantine/reversed/termination 保护。

**明确技术依赖**：现有来源选择/退款/发放 SQL 包含 Stripe ID；PAY-COMMON 内能改的支付发放函数可补内部关系，
但不能把 Waffo ID 塞入 Stripe 列来绕过 BILL2。BILL2 核心 join 的通用化及与 PAYG 的交叉回归由总控排到独立
授权切片；该切片和 PAY-WAFFO 通过之前 Waffo 禁止收费。本方案不承诺在排除 BILL2 改动时完成其跨渠道能力。

## 6. 建议 PR 拆分、迁移与恢复

全部实现 PR 为 high；本 PR 是 PR-0，仅文档。各切片实施、外部效果和合并遵循有效授权；当前没有实施授权。

| PR | 具体范围 / 风险 / 完成出口 |
| --- | --- |
| PR-1：公共身份与冻结契约 | 原订单/订阅/grant 增量字段、一张最小来源映射、约束/RLS、购买快照与迁移测试；支付目录/事实 helper。high：数据与权限。Stripe 历史兼容、迁移二次运行/空库指纹通过；不启用新购买渠道 |
| PR-2：Stripe 公共购买与履约 | payments 下单先落单、稳定幂等身份、回调/返回页/续费/取消/凭证、发放快照与会员事实解析；原支付 RPC 局部扩展。high：钱路/权益。全量原 Stripe 回归 + 新允许/拒绝与重放测试，故障后可恢复；不改 BILL2 消费核心 |
| PR-3：后台渠道选择与订单投影 | 等 Claude ENTITLEMENTS PR-2 和个人中心小修补交接后，在最终容器加 D17 设置、目录就绪投影、订单渠道/凭证显示与测试。high：渠道控制影响未来交易。Stripe 沙箱手动选择可用，Waffo 未接入明确拒绝；不得开放正式收费 |
| PR-4：退款规则与整体验收 | P1 确认后补现有页面政策说明、退款只读核对信息/审批引用（复用原订单 metadata），完善现金退款事实与权益/注销兼容回归。high：商业规则和退款。不得新造退款执行平台；人工退款仍逐笔批准，原渠道事实不被拒收 |

按最小改动先局部提取大文件中本次必须修改的职责，单文件/行宽不超工程限制，不趁机整包重构或调高基线。
若切片触及共享 `settings.ts`、`admin.ts`、大小基线、DB 测试入口或 built 指纹，先由总控确定单一 writer 与顺序。

迁移编号在各实现 PR 开工时按最新 staging 与已安排在途迁移确定，不预占 0159 或任何编号。
只追加迁移，不改历史 SQL。实施前在授权的本地文件建库做结构/数据预检：缺失映射、多重订阅、孤儿 grant、
重复外部身份、金额单位不明、历史 snapshot 缺证据分别报告；不写删除或猜测回填。
旧 Stripe 记录只在身份/环境来源可证时增量关联；正式库按现有规则全新建库，不迁移 staging 测试数据。
商户/模式无法仅由代码可靠推定的历史记录先隔离待核对，不能默认贴成正式 Stripe。

采用扩展兼容：先加列/关系与校验、旧读路径仍可用，再切新写路径；回滚应用时保留新增财务记录，
禁止 drop 已产生交易的列/表或重发 grants。未发生新渠道交易前可回旧 Stripe 兼容代码；已有新渠道交易后
只能暂停该渠道新销售并前向修复，历史回调/退款/凭证仍必须在线处理，不能以切设置冒充回滚。
每份迁移在历史位置连续执行两次，测试最小权限、无数据丢失及恢复；有结构变更才生成新的 built 指纹。
远程迁移应用与配置均另经 Owner 批准，本方案不提供远程执行命令。

## 7. 必测矩阵与交付证明

| 场景 | 允许路径 | 拒绝 / 并发 / 恢复路径 |
| --- | --- | --- |
| 设置权限 | 管理员单项/批量保存并刷新读回 | 普通用户/匿名 API 与直接表写拒绝；非法渠道、过期版本、批量绕过、读失败拒绝；客户端指定渠道无效 |
| 新购买 | 可用主体、上架商品、Stripe 测试模式、合法快照 | 未登录/封闭/未验证/他人订单、价格币种不符、下架、Waffo 未接入、无映射拒绝，零外部副作用 |
| 手动切换 | A 渠道原订单继续走 A，新意图走 B | 与下单并发明确次序；已有订阅升级仍 A；未知结果切 B 不产生第二次扣款；停止 A 新售不停止 A 历史处理 |
| 幂等 | 同请求同负载恢复同订单、同外部身份 | 同 key 异负载拒绝；双击/并发回调/返回页一次履约；创建成功落库失败、回调先到、事务提交后崩溃恢复 |
| 回调 | 合法签名、匹配模式/商户/金额/归属的权威付款 | 错签名、跨模式/商户/对象重名、重复事件、不同事件同发票、乱序、旧状态迟到、冲突回执；不重发、不翻终态 |
| 会员判定 | 持久化真实付款 → 新请求允许；付款恢复即时允许；管理员合法授予 | 欠费/未完成/退款核对、未知渠道、冲突、管理员拒绝均拒绝；既有购买 allowed=false 不应阻止正常功能使用 |
| 年付/升级/到期 | 原 UTC 锚点 12 期、月底/闰年、正确余数，升级 full-target/no-proration | webhook 与 cron 同期一次；取消续费不退当期、不自动恢复续费；退款停止未来发放；编辑商品不重写已冻结当期 |
| 退款与来源 | 已批准且确认成功的测试退款只回收目标未用来源 | 未批准不给执行入口；部分/全额、失败/未知/重复/乱序；消费同时退款；迟到释放不能复活 reversed，其他来源不变 |
| 注销 | 已停止续费可申请；封闭后原渠道账务可合法收尾 | 自动续费中拒绝；新下单与注销竞态；迟到付款/退款不恢复访问；三年白名单和正文删除、未决证据保护 |
| 开户/邀请 | 原首次资格允许，原余额来源保留 | 购买/重放/切换不再次赠送；重复身份或领取拒绝；消费返利不开启 |
| 凭证/财务/页面 | 本人订单原卖家凭证、原币种精度、后台渠道显示 | 他人凭证拒绝；净额/税/费未知不伪零；旧单不跳新默认；窄屏、保存失败、刷新与安全错误提示 |

支付全部仅用沙箱/测试模式；本地 fixture 不冒充真实沙箱证明。没有外部配置授权时，用本地隔离库和 stub
完成确定性验证，真实沙箱端到端标 NOT_RUN 并列为实施交付阻塞，不请求 Owner 替代技术验证。
外部沙箱验证前先核对已批准入口及当前回调可用性；不得为修验证擅改供应商设置或真实付款。

每个实现 PR 执行相关 API/web 单测、lint/typecheck、代码大小、CI safeguard、迁移账本及完整 required CI。
迁移执行本地文件建库与指纹检查，测试实际角色/RLS 的允许和拒绝，不只 mock；UI 做本地或获准 Preview 浏览器验证。
BILL2 来源兼容仅运行现有本地回归，不改核心；跨渠道交叉测试缺口随依赖明确交接。
不因为文档或本地通过跳过 CI。通过、失败、跳过、未运行分列；语义审查和 Owner 产品验收分别记录。

## 8. 仅需 Owner 决定的产品问题

### P1：默认不退款与原退款规则的衔接

E5 已定，不重新问是否退款。需要确认的是实施时如何向用户呈现、如何保留旧退款能力。
推荐：订阅和积分包统一展示“付款成功后默认不退款，可联系支持申请人工例外”；不增加自助/自动退现金入口，
不改变已付当期取消规则；人工例外逐笔批准后沿原渠道处理，保持现有订阅退款来源回收和年付停止语义。
支付商已发生退款仍必须记账；未交付调用的积分释放不受现金退款政策限制。

可复制批准话：**同意 PAY-COMMON 按上述 P1 衔接：付费成功默认不退款，人工例外逐笔批准，保留原渠道退款核对、
订阅来源回收和未来年付停止规则；不新增自助或自动现金退款。**

### P2：上线产品数值复核（不阻塞公共结构实施）

Master Plan 已要求上线前复核开户赠送、邀请、会员套餐及积分包数值。推荐本次完全保留现有数值，
到实际准备开放付费时给 Owner 一张当前产品价目/积分表统一确认，不把美元换算比例直接套成商品涨跌价。

可复制批准话：**PAY-COMMON 保持现有价格、套餐与赠送积分不变，开放付费前再由我确认完整产品数值。**

D17 手动切换、Waffo 默认、未知不跨渠道重试、三年账务保留、E4、ENTITLEMENTS P1–P5、q/m 均已定，不重复索取。
迁移编号、文件拆分、测试、幂等键和排队由 Agent/总控处理，不让 Owner 选技术事项。
实际 Stripe 直收责任确认、渠道正式启用、远程迁移及上线属于执行前审批，不把本文批准话当成这些授权。

## 9. 本方案交接状态

已做：读取指定文档、最新 staging 政策、现有实现/表定义、全部 open PR 文件和相关本地 writer；
记录代码缺口、D17 行为、任务交界、PR 拆分、迁移策略、验证与产品决定。
本地文档检查与远程 CI 的实际结果、最终 head 由本 PR Handoff 记录，不能将未来必测项写为已通过。

下一步：CI 通过后，writer 在 PR 留带准确 head 的“可以审查”评论并停止写入；总控安排独立审查。
阻塞：P1 的产品衔接尚待确认；后续实施等待方案批准、Claude 相关前端交接以及总控安排 BILL2 来源兼容依赖。
未运行：实现支付测试、沙箱交易、运行/页面验收、远程数据库核验和迁移；它们不属于本次文档任务。
本次不请求独立审查服务、不改 ready 状态、不合并。
