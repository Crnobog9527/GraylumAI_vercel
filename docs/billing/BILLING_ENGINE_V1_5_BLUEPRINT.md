# GraylumAI Billing Engine v1.5 架构蓝图与落地施工方案

> 版本：v1.0-owner-draft
> 项目：`Crnobog9527/GraylumAI_vercel` / graylum 网站维护
> 目标分支策略：所有开发默认从 `origin/staging` 建分支；完成 staging 验收后再单独做 main release。
> 核心 owner 决策：**年付订阅积分必须按月释放，不允许一次性发放全年积分。**

---

## 0. 文档目的

本文档用于让 Codex 持续执行 Billing Engine v1.5 收口工程，避免继续按单点 bug 补洞。

本文档同时作为 owner、Codex、审计员三方的共同执行依据：

1. 明确 billing engine 的目标架构。
2. 明确不可违反的业务规则。
3. 明确数据库、API、webhook、前端展示、测试与验收标准。
4. 明确 Codex 的自动执行方式、分支策略、PR 顺序、测试门槛和停止条件。
5. 降低 owner 作为“截图/提示词搬运工”的负担，让 Codex 以任务计划为中心持续执行。

---

## 1. 已敲定业务规则

### 1.1 积分规则

1. 用户积分余额可累积，不按月清零。
2. 积分余额应由 append-only ledger 流水计算，`profiles.credits` 只能作为展示/快速授权缓存。
3. AI 使用消耗才计入“本月消耗”。
4. 退款扣回、管理员扣减、积分过期、系统调整均不计入“本月消耗”。
5. 退款扣回应显示为“退款扣回 / 订单退款扣除积分”，不得显示为“积分消耗”。

### 1.2 订阅积分发放规则

1. 月付订阅：每个 paid invoice 发放当期月度积分。
2. 年付订阅：用户支付的是一年订阅，但积分必须按月释放。
3. 年付订阅不得一次性发放全年积分。
4. 年付订阅的 `yearly_credits` 表示全年可释放总积分，应按 12 个周期分摊释放。
5. 年付用户取消自动续费但未到期时，权益仍有效，且应继续按月释放积分，直到 `current_period_end`。
6. 年付订阅全额退款后，停止未来月度释放，并按退款策略扣回已释放积分。
7. 年付订阅续费成功后，开启新的 12 个月释放周期。

### 1.3 会员升降级规则

1. Free 可以购买 Pro / Gold 的月付或年付。
2. Pro 可以升级到 Gold。
3. 月付可以升级到年付。
4. Gold 不允许降级到 Pro。
5. 年付不允许立即降级到月付。
6. 同级同周期不允许重复购买。
7. active 订阅用户不得通过新 checkout 创建第二个 active subscription。
8. 订阅升级必须走 Stripe subscription update / pending update / schedule，不得用新 checkout 创建第二份订阅。
9. `cancel_at_period_end` 但未到期的用户仍按 active 权益处理；必须先明确恢复续费后才可升级，升级操作不得隐式恢复续费；不允许降级立即生效。
10. `past_due / incomplete / unpaid` 用户必须先处理付款异常，不允许购买/切换套餐以绕过账单问题。

### 1.4 订单状态规则

`payment_orders.status` 是 Graylum 自己的订单状态，不能混用 Stripe checkout status、invoice status、refund status。

目标状态：

```text
pending
completed
failed
canceled
expired
refunded
partially_refunded
```

兼容旧值：

```text
cancelled -> canceled
partial_refunded -> partially_refunded
```

规则：

1. 创建 checkout 只能生成 `pending`，不得生成 `completed`。
2. 只有 Stripe 已 paid 且本地 fulfillment 成功，订单才能进入 `completed`。
3. checkout 取消、过期、支付失败必须进入明确终态，不得永久 pending。
4. 失败、取消、过期订单可以在账单页显示为对应状态，不能隐藏成用户无法理解的“缺失记录”。
5. 全额退款进入 `refunded`。
6. 部分退款进入 `partially_refunded`。

---

## 2. Billing Engine v1.5 总体架构

```text
Stripe 收款/订阅/发票/退款层
   ↓ webhook / API sync
payment_orders 订单状态机
   ↓
user_subscriptions 本地订阅镜像
   ↓
membership eligibility 权益判断矩阵
   ↓
subscription_credit_grants 订阅积分释放账本
   ↓
credit_transactions v2 积分总账本
   ↓
billing_history / AI usage 三段式扣费
   ↓
前端 BillingRecordsCard / CreditRecordsCard / SubscriptionCard 展示
   ↓
reconciliation scripts / scheduled jobs 对账
```

### 2.1 Stripe 层职责

Stripe 只负责：

- checkout；
- invoice；
- subscription；
- payment；
- refund；
- dispute；
- customer；
- receipt / invoice 文件；
- Radar 支付风控。

Stripe 不负责：

- Graylum 积分账本文案；
- “本月消耗”统计；
- 会员升降级业务矩阵；
- 年付积分月度释放；
- 前端账单标签；
- AI 使用扣费。

### 2.2 Postgres 层职责

Postgres 是权威事实来源，必须保存：

- payment orders；
- subscription mirror；
- subscription credit grants；
- credit ledger；
- AI usage billing history；
- webhook / fulfillment 幂等记录；
- reconciliation 结果。

### 2.3 Redis 层职责

v1.5 阶段 Redis 不作为积分钱包事实来源。

Redis 可以继续用于：

- rate limit；
- concurrency limit；
- 临时缓存。

不要在 v1.5 阶段把积分余额主事实迁移到 Redis。当前最重要的是账本正确，不是毫秒级钱包性能。

---

## 3. 数据模型蓝图

> 原则：优先增量扩展现有表，不做一次性大重构。历史字段保留兼容，新语义逐步接管。

### 3.1 `payment_orders` 改造

目标字段：

```sql
status                text not null -- pending/completed/failed/canceled/expired/refunded/partially_refunded
payment_status        text          -- Stripe payment_status，只作为外部状态保存
status_reason         text          -- 状态来源说明
status_updated_at     timestamptz
terminal_at           timestamptz   -- 进入终态时间
metadata              jsonb
```

目标：

1. `status` 只表达 Graylum 内部订单状态。
2. `payment_status` 只保存 Stripe payment status。
3. `metadata` 继续保存 checkoutSessionId、invoiceId、refundId、paymentIntentId、chargeId、subscriptionId、fulfillmentSource 等事件证据。
4. 所有状态更新必须幂等。

### 3.2 `credit_transactions` v2 改造

当前 `type` 太粗，需要新增更细语义字段，但暂不删除旧字段。

建议新增字段：

```sql
ledger_type       text -- grant/spend/refund_clawback/adjustment/expiration
reason_code       text -- subscription_grant/topup_purchase/ai_task_spend/refund_clawback/admin_adjustment/annual_monthly_release/...
counts_as_spend   boolean default false
source_type       text -- stripe_invoice/stripe_checkout/stripe_refund/ai_task/admin/system
source_id         text
source_order_id   uuid
source_refund_id  text
grant_period_key  text -- YYYY-MM or subscription period key
metadata          jsonb
```

目标类型表：

| ledger_type | amount | counts_as_spend | 前端文案 | 用途 |
|---|---:|---:|---|---|
| grant | 正数 | false | 积分到账 / 会员积分 / 积分包到账 | 订阅、积分包、签到、邀请奖励 |
| spend | 负数 | true | AI 使用消耗 | 用户真实使用 AI |
| refund_clawback | 负数 | false | 退款扣回 / 订单退款扣除积分 | Stripe 退款导致扣回 |
| adjustment | 正/负 | false | 系统调整 / 管理员调整 | 后台人工处理 |
| expiration | 负数 | false | 积分过期 | 未来可选 |

关键规则：

```text
本月消耗积分 = SUM(abs(amount)) WHERE ledger_type = 'spend' AND counts_as_spend = true
```

不得继续用“所有负数”计算本月消耗。

### 3.3 新增 `subscription_credit_grants`

用于订阅积分释放幂等，尤其支持年付按月释放。

建议表结构：

```sql
CREATE TABLE subscription_credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  membership_plan_id uuid,
  stripe_subscription_id text not null,
  stripe_invoice_id text,
  billing_cycle text not null, -- monthly/yearly
  grant_type text not null, -- monthly_invoice/annual_monthly_release/upgrade/manual/reversal
  grant_period_key text not null, -- e.g. sub_xxx:2026-06 or invoice:in_xxx
  period_start timestamptz not null,
  period_end timestamptz not null,
  period_index integer,
  total_periods integer,
  credits_granted integer not null,
  status text not null default 'granted', -- granted/skipped/reversed/failed
  idempotency_key text not null unique,
  credit_transaction_id uuid,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

CREATE INDEX idx_subscription_credit_grants_user_time
  ON subscription_credit_grants (user_id, created_at DESC);

CREATE INDEX idx_subscription_credit_grants_subscription_period
  ON subscription_credit_grants (stripe_subscription_id, grant_period_key);
```

### 3.4 年付月度释放金额算法

`membership_plans.yearly_credits` 表示全年总积分，不再表示一次性到账积分。

算法：

```text
base = floor(yearly_credits / 12)
remainder = yearly_credits % 12
period_index = 1..12
monthly_grant = base + 1 if period_index <= remainder else base
```

这样 12 个月累计发放值严格等于 `yearly_credits`。

示例：

```text
yearly_credits = 20000
base = 1666
remainder = 8
前 8 个月每月 1667
后 4 个月每月 1666
合计 20000
```

### 3.5 新增 `subscription_change_requests`

用于记录真实订阅升级流程，避免 active 用户创建第二个订阅。

建议表结构：

```sql
CREATE TABLE subscription_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  stripe_subscription_id text not null,
  from_plan_id uuid,
  to_plan_id uuid not null,
  from_billing_cycle text,
  to_billing_cycle text not null,
  change_type text not null, -- upgrade/cycle_upgrade/restore_cancel
  status text not null default 'requested', -- requested/pending_payment/applied/failed/canceled
  stripe_invoice_id text,
  stripe_event_id text,
  idempotency_key text not null unique,
  error text,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
```

---

## 4. 关键流程

### 4.1 新订阅购买流程

适用：Free / canceled 且已到期用户购买 Pro 或 Gold。

流程：

1. 前端请求 `createCheckoutSession(kind=membership_plan)`。
2. 后端读取 membership eligibility。
3. 如果用户没有 active subscription，允许创建 subscription checkout。
4. 创建本地 `payment_orders.status = pending`。
5. Stripe 支付成功后 webhook / sync 进入 fulfillment。
6. 更新 `user_subscriptions`。
7. 月付：按 invoice 发放当期月度积分。
8. 年付：创建 annual subscription mirror，并立即释放第 1 个年付月度积分，不发全年。
9. 写入 `subscription_credit_grants` 和 `credit_transactions`。
10. `payment_orders.status = completed`。

### 4.2 年付订阅月度释放流程

触发源：

1. 年付订阅首次 paid invoice fulfillment：立即释放第 1 个月积分。
2. Vercel Cron / scheduled job：每天扫描 annual active subscriptions，补发到当前日期应释放但未释放的月份。

规则：

1. `current_period_start` 到 `current_period_end` 切成 12 个逻辑月份。
2. 计算当前日期应已释放到第几期。
3. 查询 `subscription_credit_grants`，缺哪几期就补哪几期。
4. 每期用唯一 `idempotency_key`，防止重复发放。
5. `cancel_at_period_end = true` 但未到期，继续释放。
6. subscription 已 canceled 且已过 `current_period_end`，停止释放。
7. full refund 后，停止未来释放，并扣回已释放积分。

建议 cron：

```text
/api/cron/release-subscription-credits
schedule: 每天 03:00 UTC 或业务主时区凌晨
```

### 4.3 月付续费发放流程

1. Stripe `invoice.payment_succeeded` / paid invoice 到达。
2. 查 subscription + plan。
3. `billing_cycle = monthly`。
4. 发放 `monthly_credits + monthly_bonus_credits`。
5. 写 `subscription_credit_grants`：`grant_type = monthly_invoice`。
6. 写 `credit_transactions.ledger_type = grant`。
7. 幂等键建议：

```text
subscription_grant:monthly:{stripe_invoice_id}
```

### 4.4 订阅升级流程

适用：

- Pro 月付 -> Gold 月付
- Pro 月付 -> Gold 年付
- Pro 年付 -> Gold 年付
- Gold 月付 -> Gold 年付

禁止：

- active 用户创建第二个 subscription checkout。
- Gold -> Pro。
- 年付 -> 月付立即降级。
- 同级同周期重复购买。

目标流程：

1. 前端调用新的 `changeSubscriptionPlan` API，而不是 `createCheckoutSession`。
2. 后端读取当前 `user_subscriptions` 与目标 plan。
3. membership eligibility 判断是否允许升级。
4. 受保护预览以同一 subscription、现有 item、目标 Price、`billing_cycle_anchor=now`、`proration_behavior=none` 建模；预览不得发送 `proration_date`。
5. 预览发票必须只有完整目标周期的目标 Price line，分页完整且无 proration、旧 Price 负数抵扣、折扣、税或余额调整；`amount_due` 与当前本地目标套餐/周期目录价及 USD 币种必须完全一致，否则 fail closed。
6. 报价仅包含 `amountDue`、`currency`、`quotedAt` 与语义 fingerprint；`quotedAt` 只用于 300 秒确认时效，不参与按时间计价。确认时重新读取本地/Stripe 状态并再次执行同一全价预览；金额、币种或语义状态变化时要求重新确认。
7. 创建一个持久 plan-change source/lock，以其 id 派生稳定 Stripe idempotency key。
8. 更新同一 Stripe subscription 的现有 item：目标 Price + `billing_cycle_anchor=now` + `proration_behavior=none` + `payment_behavior=error_if_incomplete`。不得发送 `proration_date`，不得清除到期取消，也不得创建第二个 Checkout/subscription。
9. 目标套餐/周期收取当前配置的完整价格；旧套餐不退款、不按未使用时间抵扣、不计算差价，也不根据剩余或已用积分改价。新的完整目标 term 从付款成功对应的 Stripe 目标周期开始。
10. subscription update 本身不授予权益。只有精确绑定持久 source、目标 Price/customer/user、完整目标 service period 和全价金额的 paid invoice 可以更新本地 subscription、plan、billing_cycle。
11. 已有积分及历史 grant 全部保留，不反转、不扣减：
    - 月付目标：在现有余额上完整追加 `monthly_credits + monthly_bonus_credits`，恰好一次。
    - 年付目标：开始新的 12 期计划，仅追加 canonical period 1；period 2–12 继续由 YEAR-1 按月释放。
12. 写入 `subscription_credit_grants` 与 `credit_transactions`，完成并释放精确 plan-change source；paid invoice 重放不得重复 term、权益或积分。
13. 明确的付款失败保持原套餐/term/积分并安全释放失败 source；传输不确定时先读取远端，applied 不重试、unknown 保持锁，proven old 且报价过期时才退休旧 source 并要求新预览与重新确认。

### 4.5 退款流程

#### 积分包全额退款

1. `payment_orders.status = refunded`。
2. 找到该订单原始 `grantedCredits`。
3. 写 `credit_transactions.ledger_type = refund_clawback`，amount 为负数。
4. `counts_as_spend = false`。
5. 前端显示“退款扣回”。

#### 积分包部分退款

1. `payment_orders.status = partially_refunded`。
2. 按退款金额比例扣回积分。
3. 写 `refund_clawback`。
4. 不计入本月消耗。

#### 订阅 full refund

1. `payment_orders.status = refunded`。
2. 找到对应 invoice / subscription period 已释放的所有 `subscription_credit_grants`。
3. 对已释放积分写 `refund_clawback`。
4. 停止该 invoice / period 后续未释放月份。
5. 如果余额不足，允许余额变负，并阻止继续 AI 使用直到余额恢复；不要静默失败。

#### 订阅 partial refund

v1.5 最小策略：

1. `payment_orders.status = partially_refunded`。
2. 写入 `metadata.refundReviewRequired = true`。
3. 默认不自动处理复杂比例释放，进入后台/人工审计队列。
4. 前端展示“部分退款”。
5. 不把退款扣回计入本月消耗。

> 说明：订阅部分退款与年付按月释放叠加后规则复杂。为了最快完成 v1.5，部分退款先做状态展示和人工审计标记，避免自动错误扣回。

---

## 5. 前端展示规则

### 5.1 BillingRecordsCard

必须展示以下状态：

| status | 文案 |
|---|---|
| pending | 待支付 / 处理中 |
| completed | 已完成 |
| failed | 支付失败 |
| canceled | 已取消 |
| expired | 已过期 |
| refunded | 已退款 |
| partially_refunded | 部分退款 |

不能只显示 completed / paid 订单。

### 5.2 CreditRecordsCard

必须使用 `ledger_type` 决定文案。

| ledger_type | 文案 |
|---|---|
| grant | 积分到账 |
| spend | AI 使用消耗 |
| refund_clawback | 退款扣回 |
| adjustment | 系统调整 |
| expiration | 积分过期 |

### 5.3 CreditSummary

本月消耗计算：

```text
SUM(abs(amount)) WHERE ledger_type = 'spend' AND counts_as_spend = true AND created_at in current month
```

退款扣回、系统调整、积分过期不得计入本月消耗。

### 5.4 SubscriptionCard / PricingCard

必须和后端 eligibility 一致。

前端不得只按 `plan.level === currentLevel` 判断按钮状态。

按钮状态建议：

| 状态 | 文案 |
|---|---|
| 可购买 | 立即订阅 |
| 可升级 | 升级套餐 |
| 当前套餐 | 当前套餐 |
| 禁止降级 | 当前会员有效，暂不支持降级 |
| 支付异常 | 请先处理付款异常 |
| cancel_at_period_end | 当前权益仍有效；升级前须先通过订阅管理恢复续费 |

### 5.5 年付文案

年付页面必须明确：

```text
年付积分按月释放，未使用积分可累积，不按月清零。
```

不得出现“年付积分一次性到账”的文案。

---

## 6. PR 施工计划

所有 PR 默认 base：`origin/staging`。

禁止一口气做完。每个 PR 必须独立测试通过，才能进入下一个 PR。

### PR 0：只读校准 + 写入本方案文档

目标：

1. fetch 最新 `origin/main` 和 `origin/staging`。
2. 确认 main/staging SHA、ahead/behind/diverged。
3. 确认 0041/0042 在 main/staging 的迁移差异。
4. 将本文档保存到仓库：`docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`。
5. 创建执行清单：`docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。
6. 不改业务代码。

测试：

- markdown lint 如项目有；否则无需。
- 不运行生产 smoke。

### PR 1：payment_orders 状态机 + BillingRecords 展示

允许范围：

- `payments.ts`
- `stripeFulfillment.ts`
- Stripe webhook handler
- `BillingRecordsCard`
- payment status mapper / tests
- 必要 migration

目标：

1. 统一 status enum/mapper。
2. 支持 `failed/canceled/expired/refunded/partially_refunded`。
3. 兼容旧 `cancelled/partial_refunded`。
4. `checkout.session.expired`、`checkout.session.async_payment_failed`、`invoice.payment_failed` 能进入终态。
5. 账单页显示失败、取消、过期订单。
6. `completed` 只代表 paid + fulfilled。

禁止范围：

- 不改会员升级。
- 不改积分发放。
- 不触发真实 webhook replay。
- 不做 production smoke。

测试矩阵：

- pending checkout。
- completed paid checkout。
- failed async payment。
- canceled checkout。
- expired session。
- full refund status compatibility。
- partial refund status compatibility。
- BillingRecordsCard 标签快照测试。

### PR 2：credit_transactions v2 语义 + 退款扣回分类

允许范围：

- `credit_transactions` migration。
- credits router/service。
- refund reconciliation ledger write。
- `CreditRecordsCard`。
- `CreditSummary`。
- tests。

目标：

1. 新增 `ledger_type/reason_code/counts_as_spend/source_*`。
2. 历史 `deduction/addition/purchase/refund` 做兼容映射。
3. 退款扣回写成 `refund_clawback`。
4. 本月消耗只统计 `spend`。
5. 前端显示“退款扣回”。

禁止范围：

- 不做真实退款。
- 不改订阅升级。
- 不大规模清洗生产数据。

测试矩阵：

- grant 不计入本月消耗。
- spend 计入本月消耗。
- refund_clawback 不计入本月消耗。
- adjustment 不计入本月消耗。
- 旧 deduction 兼容展示。
- 退款扣回文案。

### PR 3：subscription_credit_grants + 年付按月释放引擎

允许范围：

- 新增 `subscription_credit_grants` migration。
- membership invoice fulfillment。
- subscription credit grant service。
- scheduled job / cron route。
- tests。

目标：

1. 月付 invoice 发放月度积分。
2. 年付 invoice 不再发全年积分。
3. 年付首次支付后立即释放第 1 个月积分。
4. Cron 补发应释放但未释放的年付月份。
5. `cancel_at_period_end` 未到期继续释放。
6. full refund 停止未来释放。
7. 幂等键防重复。

禁止范围：

- 不改 Stripe price。
- 不改会员升级 API。
- 不做 production cron 启用。

测试矩阵：

- 年付 yearly_credits 分 12 期总和等于 yearly_credits。
- 首次年付 invoice 只发第 1 个月。
- 重复 webhook 不重复发。
- cron catch-up 能补缺失月份。
- cancel_at_period_end 未到期继续释放。
- canceled 且到期后不释放。
- full refund 后不释放未来月份。

### PR 4：membership eligibility 矩阵前后端一致

允许范围：

- `membershipEligibility.ts`
- `SubscriptionCard`
- pricing card/button state
- tests。

目标：

1. 后端区分升级、降级、重复、付款异常。
2. 前端按钮状态与后端一致。
3. active 用户不能通过 createCheckoutSession 创建第二个 subscription。
4. 可升级场景返回明确 reason/action：应走 `changeSubscriptionPlan`。

禁止范围：

- 不实际调用 Stripe subscription update。
- 不改积分发放。

测试矩阵：

- Free -> Pro/Gold 允许 checkout。
- Pro 月付 -> Gold 月付/年付 标记可升级但不走 create checkout。
- Gold -> Pro 禁止。
- Gold 年付 -> 任意低级/同级禁止。
- cancel_at_period_end 未到期仍 active。
- past_due/incomplete/unpaid 禁止切换，提示付款恢复。

### PR 5：真实订阅升级机制

允许范围：

- 新 API：`changeSubscriptionPlan`。
- `subscription_change_requests` migration。
- Stripe subscription update / pending update / schedule integration。
- webhook fulfillment。
- tests。

目标：

1. active 用户升级不创建第二个 subscription。
2. Pro -> Gold 可升级。
3. 月付 -> 年付可升级。
4. 同一 subscription 以目标完整价格、无旧套餐退款/未使用时间抵扣/差价计算的方式开始完整目标 term。
5. 支付成功后才更新本地权益；已有积分保留，目标月付完整追加一期积分。
6. 升级到年付后只释放第 1 个月年付积分，后续期间仍可按月释放。
7. 明确付款失败保持原套餐；不确定结果保留锁并先读取远端。

禁止范围：

- 不支持降级。
- 不做真实 live-mode 付款。
- 不混入 refund PR。

测试矩阵：

- Pro 月付 -> Gold 月付。
- Pro 月付 -> Gold 年付。
- Gold 月付 -> Gold 年付。
- Gold -> Pro 被拒。
- 同级同周期被拒。
- Stripe update 失败不改本地权益。
- webhook 重复不重复发积分。

### PR 6：退款与年付月度释放联动

允许范围：

- refund reconciliation。
- `subscription_credit_grants` reversal。
- `credit_transactions.refund_clawback`。
- tests。

目标：

1. 年付 full refund 扣回已释放积分。
2. 年付 full refund 停止未来月份释放。
3. 余额不足时允许负余额，并阻止继续 AI 使用。
4. partial refund 进入人工审计标记，不错误自动扣回。

禁止范围：

- 不做真实退款。
- 不做生产数据清洗。

测试矩阵：

- full refund 已释放 3 个月 -> 扣回 3 个月。
- full refund 后 cron 不再释放第 4 个月。
- 用户余额不足 -> 负余额/blocked usage。
- partial refund -> review required，不计入本月消耗。

### PR 7：对账、监控、总验收

允许范围：

- reconciliation scripts。
- admin read-only diagnostics。
- scheduled job read-only audit。
- tests。

目标：

1. 校验 `profiles.credits` 与 `credit_transactions` 汇总一致。
2. 校验 `subscription_credit_grants` 与 `credit_transactions` 对应。
3. 校验 payment_orders 没有长期 pending 垃圾订单。
4. 校验 active subscription 不重复。
5. 校验年付每月释放没有漏发/重复发。
6. 输出 staging launch readiness report。

禁止范围：

- 不做 production smoke，除非 owner 单独授权。
- 不自动修改生产数据。

---

## 7. Codex 自动执行协议

### 7.1 执行模式

推荐模式：**Staging 自动执行，Main/Production 手动发布。**

Codex 可以持续执行 PR 0-7，但每个 PR 必须：

1. 独立分支。
2. 独立 PR。
3. 独立测试。
4. 独立最终报告。
5. CI / Security / Vercel checks 全绿后才允许进入下一个 PR。

如果 owner 明确开启 auto-merge，可仅允许 staging PR 在所有 required checks 通过后 auto-merge。main release 和 production migration 仍需要单独授权。

### 7.2 Codex 每个 PR 的固定流程

每个 PR 必须执行：

```text
1. git fetch --all --prune
2. 确认 base branch = origin/staging
3. 创建独立分支 codex/billing-v1-prXX-<topic>
4. 查看本文档对应 PR 范围
5. 只修改允许范围内文件
6. 添加/更新测试
7. 运行测试与构建
8. 修复失败直到通过，或明确阻塞
9. push 分支
10. 创建 PR 到 staging
11. 等待 checks
12. checks 失败则自动修复并 push
13. checks 全绿后输出中文 final report
14. 如 auto-merge 已授权，则启用 auto-merge；否则等待 owner/审计员确认
15. 合并后更新 execution log，再进入下一 PR
```

### 7.3 每个 PR 的必跑检查

按仓库实际脚本选择，但至少包括：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @graylum/api test
pnpm --filter @graylum/web test
```

如果仓库脚本名称不同，Codex 必须先读取 `package.json` 确认可用脚本，不得编造测试命令。

有 DB migration 时，必须补充：

```text
- migration 文件静态审查
- 本地/测试环境 migration 验证，如仓库支持
- 回滚边界说明
- 生产应用前的人工授权说明
```

### 7.4 Codex 必须更新的执行日志

创建并维护：

```text
docs/billing/BILLING_ENGINE_EXECUTION_LOG.md
```

每个 PR 合并或 ready 后追加：

```text
## PR X - 标题
- Branch:
- PR:
- Base:
- Head SHA:
- 修改范围:
- Migration:
- 测试命令:
- 测试结果:
- CI/Security/Vercel 状态:
- 已知风险:
- 后续 PR 依赖:
- 是否可进入下一 PR:
```

### 7.5 Codex 停止条件

遇到以下情况必须停止并请求 owner 决策：

1. 需要修改 production Supabase / Vercel / Stripe live settings。
2. 需要真实付款、真实退款、真实取消、真实 webhook replay。
3. 发现 main/staging migration 不一致且会影响本 PR。
4. 需要删除或重写已应用 migration。
5. 测试连续失败且无法在当前 PR 范围内修复。
6. 需要扩大到当前 PR 禁止范围。
7. 出现潜在资损路径：重复发放、错误扣款、余额不可恢复。
8. 需要改变本文件中的 owner 业务规则。

### 7.6 Staging Autopilot checkpoint / 上下文重置规则

从 Billing Engine v1.5 Staging Autopilot 开始，不允许依赖长聊天上下文作为事实来源。每个阶段必须以 GitHub / docs 事实状态为准。

每完成一个阶段，例如 PR2、PR2.x migration/runtime check、PR3、PR3.x 等，必须更新：

1. GitHub issue #225：Billing Engine v1.5 Control Plane。
2. `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。

进入下一个阶段前，必须重新执行：

1. `git fetch --all --prune`。
2. 读取 issue #225。
3. 读取 `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`。
4. 读取 `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。
5. 确认 latest `origin/staging` SHA。
6. 确认当前阶段、允许范围、禁止范围、停止条件。

如果当前 Codex 窗口上下文已经很长，或者连续完成了一个完整阶段，应优先开启新的 Codex task / 新窗口继续下一阶段。新 task 只读取 issue #225、blueprint、execution log 和最新 `origin/staging`，不得依赖旧聊天记忆。

每个新阶段开始时，必须先输出/记录 stage checkpoint：

```text
- 当前阶段
- 最新 staging SHA
- 上一阶段完成状态
- 本阶段目标
- 本阶段允许范围
- 本阶段禁止范围
- 本阶段 stopping conditions
```

如果聊天上下文、issue #225、blueprint、execution log 之间出现冲突，以以下优先级为准：

1. owner 硬规则。
2. Staging Autopilot 授权边界。
3. issue #225。
4. blueprint。
5. execution log。
6. PR 描述。
7. 当前聊天上下文。

任何时候不得因为旧聊天上下文而跳过 issue #225 / blueprint / execution log 的重新读取。

如果无法确认当前阶段状态，必须暂停并输出：

```text
Autopilot paused: owner decision required on checkpoint ambiguity.
```

---

## 8. 给 Codex 的总控提示词

```text
项目：GraylumAI_vercel / graylum 网站维护

请进入 Billing Engine v1.5 连续执行模式。目标是按 docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md 完成 PR 0-7，修复 billing、订阅、积分、年付按月释放、退款扣回、账单状态、会员升级等核心问题。

最高优先级 owner 业务规则：
1. 年付订阅积分必须按月释放，不允许一次性发放全年积分。
2. 用户积分可累积，不按月清零。
3. 退款扣回不属于积分消耗，不计入本月消耗。
4. active 订阅用户不得通过新 checkout 创建第二个 subscription。
5. 允许升级，禁止降级和同级重复购买。
6. 支付未成功或 fulfillment 未成功，不得显示为已完成。
7. Postgres 是 billing 事实来源；Redis 暂不作为 v1.5 积分钱包事实来源。

执行方式：
- 先执行 PR 0：fetch 最新 origin/main 与 origin/staging，确认分支、迁移、状态机差异，并把本方案文档保存到 docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md。
- 然后按 PR 1 到 PR 7 顺序串行执行。
- 每个 PR 必须从 origin/staging 创建独立分支。
- 每个 PR 必须只修改该 PR 允许范围内文件。
- 每个 PR 必须补测试。
- 每个 PR 必须运行仓库中实际存在的 lint/typecheck/test/build 检查。
- 检查失败必须自动修复，直到通过或触发停止条件。
- 每个 PR 创建后必须输出中文 final report，并更新 docs/billing/BILLING_ENGINE_EXECUTION_LOG.md。
- 只有 tests 和 CI/Security/Vercel checks 通过后，才允许标记 ready。

严格禁止：
- 禁止跳过 PR 顺序。
- 禁止一个 PR 混做多个阶段。
- 禁止修改 production Supabase/Vercel/Stripe live settings。
- 禁止真实付款、退款、取消、webhook replay，除非 owner 后续单独授权。
- 禁止 production smoke，除非 owner 后续单独授权。
- 禁止删除或重写已应用 migration。
- 禁止直接 staging -> main 或 main -> staging 大同步。
- 禁止改变“年付按月释放积分”规则。

停止条件：
- 需要 production/backend/env 写操作。
- 需要真实 Stripe 行为。
- 需要扩大当前 PR 范围。
- 发现重复发放/错误扣回/余额不可恢复风险。
- main/staging migration 差异影响当前 PR。
- 测试无法通过。

请先从 PR 0 开始，只读校准并保存文档，不要直接进入 PR 1，直到 PR 0 报告完成。
```

---

## 9. Owner 工作方式建议

owner 不再做“技术中转”。owner 只做三类决策：

1. 是否接受 Codex 的 PR final report。
2. 是否允许进入下一 PR。
3. 是否允许 staging -> main release / production migration / production smoke。

owner 不需要手动描述技术细节。Codex 必须根据本文档自己判断改哪些文件、跑哪些测试、如何报告。

owner 每次只需要看：

```text
- PR 是否只做了本阶段范围？
- 测试是否全绿？
- 有没有触碰禁止范围？
- 有没有资损风险？
- 是否可以进入下一 PR？
```

---

## 10. 最终验收标准

Billing Engine v1.5 完成时必须满足：

1. 支付失败、取消、过期不会显示为已完成。
2. 账单页能正确显示 pending/completed/failed/canceled/expired/refunded/partially_refunded。
3. 退款扣回显示为退款扣回，不计入本月消耗。
4. 本月消耗只统计 AI 使用 spend。
5. Pro 可以升级 Gold。
6. Gold 不能降级 Pro。
7. active 订阅不会创建第二个 subscription。
8. 月付 invoice 每期发放月度积分。
9. 年付 invoice 不发全年积分，只按月释放。
10. 年付 cancel_at_period_end 未到期继续按月释放。
11. 年付 full refund 后停止未来释放并扣回已释放积分。
12. 所有 subscription grants 幂等，重复 webhook/cron 不重复发。
13. `profiles.credits` 与 ledger 汇总可对账。
14. main/staging release 边界清楚。
15. CI/Security/Vercel checks 全绿。
