# Billing Engine v1.5 Execution Log

> 项目：GraylumAI_vercel / graylum 网站维护
> 执行模式：Billing Engine v1.5 连续执行模式
> 事实来源优先级：Postgres 为 billing 事实来源；Redis 暂不作为 v1.5 积分钱包事实来源。

## PR 0 - 只读校准与蓝图归档

### 时间

- 执行时间：2026-06-07 11:43:12 CST

### 范围

- 只执行 PR 0。
- 保存 Billing Engine v1.5 blueprint 文档。
- 创建 Billing Engine 执行日志。
- 不修改业务代码。
- 不进入 PR 1。

### 分支

- PR0 本地分支：`codex/billing-engine-v1-5-pr0`
- PR0 基点：`origin/staging`
- PR0 HEAD：`1bcfd4f1443a404328813155effae434d88da2f5`
- 工作区说明：主工作区存在未提交 `.gitignore` 改动。为避免覆盖用户改动，PR0 在干净 linked worktree 中执行。

### 远端校准

- 已执行：`git fetch --all --prune`
- `origin/main`：`e831609fcd06f714640df9099645bb1d5363790a`
- `origin/staging`：`1bcfd4f1443a404328813155effae434d88da2f5`
- `origin/main...origin/staging` ahead/behind：main-only `5`，staging-only `17`
- 状态判断：`origin/main` 与 `origin/staging` 已 diverged。

### 0041/0042 migration 差异

对比命令：

```bash
git diff --name-status origin/main origin/staging -- \
  packages/db/migrations/0041_stripe_refund_reconciliation.sql \
  packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql \
  packages/db/tests/atomic_reconcile_stripe_refund.sql \
  packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql
```

结果：

```text
D packages/db/migrations/0041_stripe_refund_reconciliation.sql
D packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql
D packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql
D packages/db/tests/atomic_reconcile_stripe_refund.sql
```

结论：

- `origin/main` 当前包含 0041/0042 refund/cancel migration 与对应 DB test。
- `origin/staging` 当前不包含这 4 个文件。
- 这是 main/staging 的 billing migration 差异，PR1 前必须作为 stop condition 处理，不能直接进入后续实现。

### Blueprint 归档

- 来源：`/Users/simon/Downloads/graylum_billing_engine_v1_5_blueprint.md`
- 目标：`docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`
- 来源行数：951
- 来源 SHA-256：`2a5e48efeadc56210d271804c62d5a0b2b0c2b07b5de66c83bbcadf9e144ea81`
- 目标行数：950
- 目标 SHA-256：`6b775a266c87e11a6d67bf98bb2d7b95fcb36c79cac045c2041a499c86ef83f9`
- 格式处理：为通过 `git diff --cached --check`，移除了 3 处 Markdown 行尾空格和文件末尾多余空行；未改正文语义。

### Owner 业务规则锁定

- 年付订阅积分必须按月释放，不允许一次性发放全年积分。
- 用户积分可累积，不按月清零。
- 退款扣回不属于积分消耗，不计入本月消耗。
- active 订阅用户不得通过新 checkout 创建第二个 subscription。
- 允许升级，禁止降级和同级重复购买。
- 支付未成功或 fulfillment 未成功，不得显示为已完成。
- Postgres 是 billing 事实来源；Redis 暂不作为 v1.5 积分钱包事实来源。

### 验证状态

- 已完成只读 git 校准。
- 已完成 blueprint 文件保存。
- 已创建执行日志。
- `git diff --cached --check`：通过。
- markdown lint：仓库未发现 `markdownlint` / `remark` / `mdx` 相关脚本或依赖，未运行。
- `pnpm install --frozen-lockfile`：通过；仅安装 linked worktree 本地依赖，未产生 tracked 变更。
- `pnpm lint`：首次因 linked worktree 缺少 `node_modules` / `turbo` 未安装失败；安装依赖后通过。
- `pnpm --filter web typecheck`：通过。
- `pnpm test`：未通过；根脚本执行 `turbo test`，但当前 Turbo 配置找不到统一 `test` task。
- `pnpm test:api`：通过；40 个 test files / 485 个 tests passed。
- `pnpm build`：首次因缺少构建期 Supabase 环境变量失败；使用本地 dummy、非 secret 的构建变量复跑通过。
- Git scope：staged 变更仅包含 `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md` 与 `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。

### 停线状态

- PR0 报告完成前不进入 PR1。
- 发现 main/staging migration 差异：后续 PR1 不应直接开始，除非 owner 明确授权如何处理 0041/0042 差异。
- 未执行 production smoke。
- 未执行真实付款、退款、取消、webhook replay。
- 未修改 Supabase/Vercel/Stripe live settings。

## PR 0.5 - main/staging billing baseline reconciliation

### 时间

- 执行时间：2026-06-07 13:06:54 CST

### 范围

- 只执行 PR 0.5。
- 从最新 `origin/staging` 创建独立分支。
- 只 backport `origin/main` 已有的 0041/0042 refund/cancel migration 与对应 DB tests。
- 不修改业务代码、前端代码、package manifest、lockfile、配置或非 0041/0042 migration。
- 不进入 PR 1。

### 分支

- PR0.5 本地分支：`codex/billing-v1-pr0-5-baseline-reconciliation`
- PR0.5 基点：`origin/staging`
- PR0.5 base SHA：`8699b2c83b983455439cdda7cb77035b6ff65e42`
- `origin/main` SHA：`e831609fcd06f714640df9099645bb1d5363790a`

### Backport 文件

只读 diff 确认 `origin/main` 相对 `origin/staging` 独有的 0041/0042 相关文件：

```text
A packages/db/migrations/0041_stripe_refund_reconciliation.sql
A packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql
A packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql
A packages/db/tests/atomic_reconcile_stripe_refund.sql
```

本 PR 仅恢复上述 4 个文件：

- `packages/db/migrations/0041_stripe_refund_reconciliation.sql`
- `packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql`
- `packages/db/tests/atomic_reconcile_stripe_refund.sql`
- `packages/db/tests/atomic_downgrade_canceled_subscription_profile.sql`

### 一致性

- 4 个 backport 文件均使用 `git restore --source origin/main -- <path>` 恢复。
- 4 个 backport 文件均已用 `cmp` 确认与 `origin/main` byte-for-byte 一致。
- 未 cherry-pick 无关 commit。
- 未执行 full branch sync。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未触发 checkout、payment、refund、cancel、webhook replay。
- 未执行 production smoke。
- 未修改 Vercel/Supabase/Stripe backend/env。
- 未改写 0041 文件内容；0041 保持与 `origin/main` 完全一致。

### 验证状态

- `git diff --cached --check`：通过。
- `pnpm install --frozen-lockfile`：通过；仅安装 linked worktree 本地依赖，未产生 tracked 变更。
- `pnpm lint`：通过。
- `pnpm --filter web typecheck`：通过。
- `pnpm test:api`：通过；40 个 test files / 485 个 tests passed。
- `pnpm build`：首次因缺少构建期 Supabase 环境变量失败；使用本地 dummy、非 secret 的构建变量复跑通过。
- DB tests：仓库没有独立 npm DB test 脚本；新增 SQL test 文件注释要求 against migrated database with psql，且本 PR 禁止执行 DB migration / 真实数据库写操作，因此不运行真实 DB SQL tests，只做文件一致性与静态范围校验。

### 停线状态

- PR1 仍不得开始，直到 PR0.5 合入并确认 `origin/staging` 具备 0041/0042 source-code baseline。

## Control Plane - GitHub issue 工作流

### 时间

- 执行时间：2026-06-07 14:05:29 CST

### GitHub 控制台

- Control Plane issue：[#225](https://github.com/Crnobog9527/GraylumAI_vercel/issues/225)
- 当前 `origin/staging` SHA：`11516ae77906c0f3b24c002c145f253a1afd80de`
- 当前 Billing Engine 阶段：PR 1 planning gate / `not_started`
- 最新完成阶段：PR 0.5 / `merged`

### 阶段状态源

从本记录开始，Billing Engine v1.5 执行状态必须沉淀在：

- GitHub Control Plane issue。
- 对应 GitHub PR 描述。
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。

不再依赖 owner 在 Codex 和 ChatGPT 之间手动转述长报告。

### 每个 Billing Engine PR 的固定要求

- PR 描述必须链接 Control Plane issue。
- PR 描述必须写清楚本 PR 阶段、允许范围、禁止范围、测试结果。
- PR 完成后必须更新本执行日志。
- PR 完成后必须更新 Control Plane issue。
- PR 进入 owner audit 前，必须确认 GitHub checks、Vercel checks、本地 lint/typecheck/test/build、changed files scope、本执行日志、Control Plane issue 均已满足。

### 合并规则

- docs-only / baseline-only PR：checks 全绿后可请求 owner 合并。
- billing 业务代码 PR：checks 全绿后只标记 ready candidate，不得自行合并，必须等 owner audit。
- production / Supabase DB / Vercel env / Stripe live / 真实付款退款取消 / webhook replay：必须单独停止并请求 owner 明确授权。

### 严格禁止范围

- 禁止绕过 branch protection。
- 禁止在未通过测试时标记 ready。
- 禁止把多个阶段混进一个 PR。
- 禁止 owner 未授权时触发 production smoke。
- 禁止 owner 未授权时执行 Supabase DB migration。
- 禁止 owner 未授权时触发真实 checkout / payment / refund / cancel / webhook replay。
- 禁止修改 Stripe live / Vercel env / Supabase production settings。
- 禁止改变“年付按月释放积分”规则。

### Owner 最小审计口令

后续每个 PR 完成后，Codex 最终回复只需要输出一句短句，例如：

```text
PR #<number> ready for owner audit. Control Plane issue updated.
```

### 本次 docs-only 验证状态

- `git diff --cached --check`：通过。
- `pnpm install --frozen-lockfile`：通过；未产生 tracked lockfile/package 变更。
- `pnpm lint`：通过。
- `pnpm --filter web typecheck`：通过。
- `pnpm test:api`：通过；40 个 test files / 485 个 tests passed。
- `pnpm build`：首次因缺少构建期 Supabase 环境变量失败；使用本地 dummy、非 secret 的构建变量复跑通过。
- Git scope：仅修改 `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。
- 禁止动作：未进入 PR 1，未修改业务代码/migration/package/lockfile/平台配置，未执行 DB migration、Stripe 行为或 production smoke。

### 停线状态

- 本次仅建立 Control Plane，不进入 PR 1 实现。
- PR 1 可以在 Control Plane issue 与本日志更新合入后，从最新 `origin/staging` 独立分支开始。

## PR 1 - payment_orders 状态机 + BillingRecords 展示

### 时间

- 执行时间：2026-06-07 17:36 CST

### Control Plane

- Control Plane issue：[#225](https://github.com/Crnobog9527/GraylumAI_vercel/issues/225)
- PR：[#227](https://github.com/Crnobog9527/GraylumAI_vercel/pull/227)
- 阶段：PR 1 / `ready_for_owner_audit`
- Base：`origin/staging`
- Branch：`codex/billing-v1-pr1-payment-orders-state-machine`
- PR 创建前 implementation commit：`b98431131a0e74235cb224943b3c5e0e379fce16`

### 修改范围

- `packages/api/src/services/paymentOrderStatus.ts`
- `packages/api/src/services/stripeFulfillment.ts`
- `packages/api/src/routers/payments.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts`
- `apps/web/src/components/profile/BillingRecordsCard.tsx`
- `apps/web/src/components/profile/SubscriptionCard.tsx`
- `apps/web/src/components/profile/billingRecordStatus.ts`
- `packages/db/migrations/0043_payment_order_status_machine.sql`
- `packages/db/schema.ts`
- PR1 相关 API/unit tests

### 行为收口

- checkout 创建后本地 `payment_orders.status` 仅写入 `pending`。
- paid checkout session 不再被 `upsertPaymentOrderBySession` 直接标记为 `completed`。
- `completed` 仅由 fulfillment RPC 成功后写入。
- `checkout.session.expired` 进入 `expired`。
- `checkout.session.async_payment_failed` 进入 `failed`。
- `invoice.payment_failed` 会将对应未 fulfillment 的订阅 checkout/invoice order 标记为 `failed`。
- 用户从 Stripe cancel URL 返回时，同步本地订单为 canonical `canceled`；旧 `cancelled` URL 仍兼容。
- `cancelled -> canceled`、`partial_refunded -> partially_refunded` 在 API/UI 层归一。
- BillingRecords 不再只显示 completed/paid 订单，会显示 pending、failed、canceled、expired、refunded、partially_refunded。

### Migration

- 新增 source-only migration：`packages/db/migrations/0043_payment_order_status_machine.sql`。
- 目的：扩展 `payment_orders_status_check`，支持 canonical PR1 状态，并保留 `cancelled` / `partial_refunded` legacy compatibility。
- 本 PR 未执行任何 Supabase DB migration。
- staging / production migration 应用必须等待 owner 单独授权。

### 测试命令

- `pnpm install --frozen-lockfile`
- `pnpm --filter @repo/api test:run -- paymentOrderStatus stripeFulfillment payments billingRecordStatusPresentation`
- `git diff --check`
- `pnpm lint`
- `pnpm --filter web typecheck`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`

### 测试结果

- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- targeted API tests：通过；42 test files / 495 tests passed。
- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm --filter web typecheck`：通过。
- `pnpm test:api`：通过；42 test files / 495 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env。

### CI / Security / Vercel 状态

- PR #227 已创建为 draft。
- GitHub / Vercel checks 需要等待远端完成；全绿后才允许标记 ready candidate。
- billing 业务代码 PR 不自动合并，必须等待 owner audit。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未触发真实 checkout / payment / refund / cancel / webhook replay。
- 未执行 production smoke。
- 未修改 Stripe live / Vercel env / Supabase production settings。
- 未实现会员升级。
- 未实现 credit ledger v2。
- 未实现年付按月释放。
- 未实现退款扣回分类。
- 未修改 `package.json` / `pnpm-lock.yaml`。

### 已知风险

- `0043_payment_order_status_machine.sql` 合入后仍需 owner 单独授权才可应用到 Supabase DB；应用前，真实环境写入 `canceled` / `expired` / `partially_refunded` 依赖数据库约束已扩展。
- 0043 暂保留 `cancelled` / `partial_refunded` legacy values，是为了兼容既有 0041 refund RPC 和历史数据；后续 PR 可在更完整 refund 语义阶段继续收敛。

### 后续 PR 依赖

- PR2 继续处理 `credit_transactions` v2 语义与退款扣回分类。
- PR3 继续处理 `subscription_credit_grants` 与年付按月释放。
- PR1 不进入 PR2，直到 owner audit 完成。

### 是否可进入下一 PR

- 当前状态：PR #227 draft，等待 GitHub/Vercel checks。
- checks 全绿后只标记 ready candidate，不合并。

## PR 1 - owner audit fix：invoice.payment_failed 续费失败独立账单行

### 时间

- 执行时间：2026-06-07 18:05 CST

### 背景

- Owner audit 退回 PR #227，指出 `invoice.payment_failed` 续费失败场景下，旧逻辑可能 fallback 到原始 completed checkout order。
- completed/fulfilled order 会被 durable preserve，导致新的失败续费 invoice 没有生成 failed `payment_orders` 记录，账单页看不到本次失败。

### 修复范围

- `packages/api/src/services/stripeFulfillment.ts`
- `packages/api/src/services/__tests__/stripeFulfillment.test.ts`
- `packages/api/src/routers/payments.test.ts`

### 修复行为

- 如果 `invoice.payment_failed` 找到当前 `stripe_invoice_id` 对应订单：只在非 durable 状态下更新为 `failed`。
- 如果没有当前 invoice order，且找到的是首笔订阅 checkout pending order：保留就地标记 `failed` 的能力。
- 如果没有当前 invoice order，且订阅源订单是 completed/fulfilled/refund durable order：不覆盖原订单，只使用其可推断字段创建独立 failed invoice `payment_orders` 记录。
- 新 failed invoice order 写入 `user_id`、`item_type = membership_plan`、`item_id`、`billing_cycle`、`stripe_invoice_id`、`stripe_subscription_id`、`stripe_customer_id`、`stripe_price_id`、`amount_total`、`currency`、`mode = subscription`、`status = failed`、`payment_status` 与 `metadata.source = invoice.payment_failed` 等审计字段。
- 如果无法推断 `user_id` / `item_id` / `membership_plan` 信息，只记录 safe warning，不覆盖 completed checkout order。
- completed/refunded/partially_refunded durable order 仍不会被失败事件覆盖。
- BillingRecords 测试补充 failed membership invoice order 展示断言。

### 测试命令

- `pnpm --filter @repo/api test:run -- paymentOrderStatus stripeFulfillment payments billingRecordStatusPresentation`
- `git diff --check`
- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm --filter web typecheck`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`

### 测试结果

- PR1 targeted API tests：通过；42 test files / 497 tests passed。
- `git diff --check`：通过。
- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- `pnpm lint`：通过。
- `pnpm --filter web typecheck`：通过。
- `pnpm test:api`：通过；42 test files / 497 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env。Next static generation 中若干页面首次超过 60s 后自动 retry，最终 39/39 pages generated successfully。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未触发真实 checkout / payment / refund / cancel / webhook replay。
- 未执行 production smoke。
- 未修改 Stripe live / Vercel env / Supabase production settings。
- 未实现会员升级。
- 未实现 credit ledger v2。
- 未实现年付按月释放。
- 未实现退款扣回分类。
- 未修改 `package.json` / `pnpm-lock.yaml`。

### CI / Security / Vercel 状态

- 修复提交推送后需等待 GitHub/Vercel checks 重新完成。
- checks 全绿后只标记 ready candidate，不合并。

### 是否可进入下一 PR

- 不进入 PR2。
- PR #227 仍需 owner audit / merge gate。

## Staging Autopilot checkpoint / 上下文重置规则

### 时间

- 执行时间：2026-06-08 CST

### 背景

- Owner 要求 Billing Engine v1.5 Staging Autopilot 不再依赖长聊天上下文作为事实来源。
- 每个阶段必须以 GitHub issue #225、blueprint、execution log、最新 `origin/staging` 为准。
- 本次仅增加控制面 checkpoint 规则，不进入 PR2，不修改业务代码。

### 新增规则

- 每完成一个阶段，例如 PR2、PR2.x migration/runtime check、PR3、PR3.x 等，必须更新 issue #225 和本 execution log。
- 进入下一个阶段前，必须重新执行 `git fetch --all --prune`，读取 issue #225、`BILLING_ENGINE_V1_5_BLUEPRINT.md`、本 execution log，并确认 latest `origin/staging` SHA、当前阶段、允许范围、禁止范围、停止条件。
- 如果当前 Codex 窗口上下文已经很长，或者连续完成了一个完整阶段，应优先开启新的 Codex task / 新窗口继续下一阶段。
- 新 task 只读取 issue #225、blueprint、execution log 和最新 `origin/staging`，不得依赖旧聊天记忆。
- 每个新阶段开始时，必须先输出/记录 stage checkpoint：
  - 当前阶段
  - 最新 staging SHA
  - 上一阶段完成状态
  - 本阶段目标
  - 本阶段允许范围
  - 本阶段禁止范围
  - 本阶段 stopping conditions
- 如果聊天上下文、issue #225、blueprint、execution log 之间出现冲突，以以下优先级为准：
  1. owner 硬规则
  2. Staging Autopilot 授权边界
  3. issue #225
  4. blueprint
  5. execution log
  6. PR 描述
  7. 当前聊天上下文
- 任何时候不得因为旧聊天上下文而跳过 issue #225 / blueprint / execution log 的重新读取。
- 如果无法确认当前阶段状态，必须暂停并输出：

```text
Autopilot paused: owner decision required on checkpoint ambiguity.
```

### 修改范围

- `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- GitHub issue #225

### 禁止动作确认

- 未进入 PR2。
- 未修改业务代码、测试代码、migration、package、lockfile。
- 未执行 Supabase DB migration。
- 未触发 checkout / payment / refund / cancel / webhook replay。
- 未执行 production smoke。
- 未修改 Vercel / Supabase / Stripe backend/env。

## PR 2 - credit_transactions v2 语义 + 退款扣回分类

### 时间

- 执行时间：2026-06-08 CST

### Control Plane

- Control Plane issue：[#225](https://github.com/Crnobog9527/GraylumAI_vercel/issues/225)
- PR：[#230](https://github.com/Crnobog9527/GraylumAI_vercel/pull/230)
- 阶段：PR 2 / `ready_for_owner_audit`
- Base：`origin/staging`
- Base SHA：`964a0fa8d7ebbbd7a1ea16ac27b88d0c0803880e`
- Branch：`codex/billing-v1-pr2-credit-ledger-v2`
- Implementation commit：`27460145656f462fd95bfc5806fb8263519eb85d`

### Stage checkpoint

- 已执行 `git fetch --all --prune`。
- 已读取 issue #225。
- 已读取 `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`。
- 已读取 `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`。
- 已确认最新 `origin/staging` SHA：`964a0fa8d7ebbbd7a1ea16ac27b88d0c0803880e`。
- 已确认 PR0 / PR0.5 / Control Plane / PR1 / PR1.1 / PR1.2 / #229 均已完成。
- 已确认当前阶段为 PR2：`credit_transactions v2 语义 + 退款扣回分类`。

### 修改范围

- 新增 `credit_transactions` v2 source migration：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql`。
- 更新 Drizzle schema：`packages/db/schema.ts`。
- 新增 API ledger 语义 helper：`packages/api/src/services/creditLedger.ts`。
- 更新 `credits.getCreditTransactions` / `credits.getCreditsSummary`，返回 normalized `ledger_type` / `reason_code` / `counts_as_spend`，并且本月消耗只统计 AI spend。
- 更新用户使用统计与 daily billing reconciliation 的 spend 统计语义，不再把退款扣回当作消耗。
- 更新 `CreditRecordsCard` 与前端 presentation helper，退款扣回显示为“退款扣回”，每日趋势只统计 spend。
- 补充 API/unit tests 与 DB smoke tests。

### Migration

- 新增 source-only migration：`0044_credit_transactions_v2_semantics.sql`。
- Migration 内容：新增 `ledger_type`、`reason_code`、`counts_as_spend`、`source_type`、`source_id`、`source_order_id`、`source_refund_id`、`grant_period_key`、`metadata`；增加 normalization trigger；补 v2 indexes；兼容历史 `deduction/addition/purchase/refund` 语义。
- 本 PR 未执行任何 Supabase DB migration。
- staging / production migration 应用必须等待 owner 单独授权。

### 行为收口

- `refund_clawback` 负数不会计入本月消耗。
- 旧 `Stripe refund credit clawback` / `stripe_refund:*` 交易兼容识别为 `refund_clawback`。
- 旧 AI `deduction` 兼容识别为 `spend`。
- `grant` / `adjustment` / `expiration` 默认不计入本月消耗。
- 前端积分记录按 ledger 语义显示“积分到账 / AI 使用消耗 / 退款扣回 / 系统调整 / 积分过期”。

### 测试命令

- `pnpm install --frozen-lockfile`
- `pnpm --filter @repo/api test:run -- creditLedger credits billingReconciliation creditLedgerPresentation`
- `pnpm --filter web typecheck`
- `pnpm lint`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`
- `git diff --check`

### 测试结果

- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- targeted API tests：通过；44 test files / 503 tests passed。
- `pnpm --filter web typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test:api`：通过；44 test files / 503 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env；39/39 pages generated successfully。
- `git diff --check`：通过。
- DB SQL smoke tests：仅新增/更新 source test 文件；本 PR 禁止执行 DB migration / 真实数据库写操作，因此未 against live DB 运行。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未访问 production host。
- 未触发真实 checkout / payment / refund / cancel / webhook replay。
- 未触发 Stripe live 或真实资金行为。
- 未修改 Stripe live / Vercel env / Supabase backend/env。
- 未实现会员升级。
- 未实现 subscription_credit_grants。
- 未实现年付按月释放。
- 未做大规模生产数据清洗。
- 未修改 `package.json` / `pnpm-lock.yaml`。

### CI / Security / Vercel 状态

- PR #230 已创建为 draft，准备在本 docs status update 推送并重新通过 checks 后标记 ready。
- Vercel Preview Comments：通过。
- Vercel `graylum-ai-vercel-v1`：通过。
- Vercel `graylumai-staging`：通过。
- billing 业务代码 PR 不自动合并，必须等待 owner audit。

### 已知风险

- `0044_credit_transactions_v2_semantics.sql` 合入后仍需 owner 单独授权才可应用到 Supabase DB。
- Migration 包含历史 ledger 兼容 backfill；生产应用前需要单独评估数据量、锁等待与回滚窗口。
- PR2 不处理年付月度释放、订阅 partial refund 人工审计队列、负余额阻止 AI 使用；这些仍属于后续 PR3/PR6 范围。

### 后续 PR 依赖

- PR2.x：staging DB 0044 migration application / runtime no-payment verification，需 owner 单独授权。
- PR3：`subscription_credit_grants` + 年付按月释放引擎。

### 是否可进入下一 PR

- 当前状态：PR #230 ready candidate for owner audit；不由 Codex merge。
- 不进入 PR3，直到 PR2 owner audit / merge gate 完成。

## PR 2 owner audit fix - top-up purchase reconciliation scope

### 时间

- 执行时间：2026-06-09 CST

### 背景

- Owner audit 退回 PR #230，暂不允许合并。
- Codex review P2 成立：`billingReconciliation.ts` 曾把所有 `grant` 都计入 `purchaseCredits`，可能让 `checkin`、`bonus_grant`、`subscription_grant` 等非购买积分掩盖 “completed payment order 没有对应 top-up/purchase credit” 的对账异常。
- PR #230 已转回 draft，在同一 PR / 同一分支内修复。

### 修复范围

- `packages/api/src/services/creditLedger.ts`
- `packages/api/src/services/billingReconciliation.ts`
- `packages/api/src/services/__tests__/creditLedger.test.ts`
- `packages/api/src/services/__tests__/billingReconciliation.test.ts`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- GitHub issue #225

### 修复行为

- 新增 `countsAsTopupPurchaseCredit(row)` helper。
- daily billing reconciliation 的 `purchaseCredits` 只统计真正 top-up / purchase credits：
  - v2：`ledger_type = grant` 且 `reason_code = topup_purchase`。
  - Stripe Checkout top-up fallback：`source_type = stripe_checkout` 且描述指向 credit package / top-up purchase。
  - legacy：`type = purchase`。
- 明确不把以下 grant / adjustment 计入 `purchaseCredits`：
  - `checkin`
  - `bonus_grant`
  - `subscription_grant`
  - admin adjustment
  - system grant
  - refund reversal / credit refund
- `deductionCredits` 继续只统计 AI spend，不统计 `refund_clawback`。

### 测试覆盖

- completed payment order + 同日 check-in grant、无 purchase credit：仍报告 mismatch。
- completed payment order + 同日 `subscription_grant`、无 purchase credit：仍报告 mismatch。
- completed payment order + v2 `topup_purchase`：通过 `purchaseCredits` 对账。
- completed payment order + legacy `type = purchase`：通过 `purchaseCredits` 对账。
- `refund_clawback` 不计入 spend / `deductionCredits`。

### 测试命令

- `git diff --check`
- `pnpm install --frozen-lockfile`
- `pnpm --filter @repo/api test:run -- creditLedger credits billingReconciliation creditLedgerPresentation`
- `pnpm --filter web typecheck`
- `pnpm lint`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`

### 测试结果

- `git diff --check`：通过。
- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- targeted API tests：通过；44 test files / 508 tests passed。
- `pnpm --filter web typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test:api`：通过；44 test files / 508 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env；39/39 pages generated successfully。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未执行 0044 migration。
- 未触发 checkout / payment / refund / cancel / webhook replay。
- 未做 production smoke。
- 未修改 Vercel / Supabase / Stripe backend/env。
- 未实现 PR3 年付按月释放。
- 未实现会员升级。
- 未进入 PR2.x。

### CI / Security / Vercel 状态

- 本地 gate 已重新通过。
- PR #230 保持 draft，等待本 owner-audit fix 推送后重新通过 GitHub / Vercel checks，再标记 ready candidate。
- billing 业务代码 PR 不由 Codex merge，必须等待 owner audit。

## PR 2 owner audit fix 2 - manual deduction spend classification

### 时间

- 执行时间：2026-06-09 CST

### 背景

- PR #230 仍有 unresolved P2 review thread。
- 旧 `purchaseCredits` review thread 已变为 outdated，但新的有效 P2 指出：admin/manual deduction 如果通过 `credits.deductCredits` 写入，默认 reason `积分消费` 或其他不含 admin / 调整关键词的 reason 会被 fallback 归类为 `spend`。
- 这会让 `getCreditsSummary`、`getUserUsageStats`、daily billing reconciliation 继续把 manual correction 错报为 AI consumption。

### 修复范围

- `packages/api/src/services/creditLedger.ts`
- `apps/web/src/components/profile/creditLedgerPresentation.ts`
- `packages/api/src/routers/credits.ts`
- `packages/api/src/routers/credits.test.ts`
- `packages/api/src/services/__tests__/creditLedger.test.ts`
- `packages/api/src/services/__tests__/billingReconciliation.test.ts`
- `packages/api/src/services/__tests__/creditLedgerPresentation.test.ts`
- `packages/db/migrations/0044_credit_transactions_v2_semantics.sql`
- `packages/db/tests/credit_transactions_v2_semantics.sql`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- GitHub issue #225

### 修复行为

- Legacy negative `deduction` fallback 不再默认等于 `spend`。
- 只有明确 AI signal 才归类为 `spend`：
  - `ledger_type = spend`
  - `source_type = ai_task`
  - `reason_code = ai_task_spend`
  - `idempotency_key` 以 `ai_spend:` 开头
  - description 指向 `AI 对话消费` / `AI 对话结算` / `AI 对话中断结算` / `ai task` / `ai spend`
- 明确 admin/manual signal 归类为 `adjustment`：
  - `source_type = admin`
  - `idempotency_key` 以 `admin_adjustment:` 或 `admin_credit_deduction:` 开头
  - description 含 `管理员` / `admin` / `调整` / `adjustment`
- `credits.deductCredits` 继续只写旧 schema 已存在字段，不插入 0044 新字段；但会写出稳定 admin signal：
  - 默认 description：`[Admin] 积分消费`
  - 有 idempotency key 时写为 `admin_credit_deduction:<adminId>:<requestKey>`
- 前端 `CreditRecordsCard` presentation helper 同步同一分类规则，避免 UI 把 admin/manual deduction 显示为 AI spend。
- 0044 migration source 的 future trigger 同步同一规则；本次未执行 migration。

### 测试覆盖

- `countsAsCreditSpend` 不统计 `source_type = admin`、`admin_credit_deduction:*`、默认 `积分消费` manual deduction。
- Legacy `AI 对话消费` 仍统计为 AI spend。
- Daily reconciliation 中 admin/manual deduction 不计入 `deductionCredits`。
- `credits.deductCredits` 默认 reason 写出 admin adjustment signal。
- `CreditRecordsCard` 对 admin/manual deduction 显示为系统调整，不显示为 AI 使用消耗。
- DB smoke source 覆盖 future 0044 trigger 对默认 admin deduction 的 adjustment 分类。

### 测试命令

- `pnpm --filter @repo/api test:run -- creditLedger credits billingReconciliation creditLedgerPresentation`
- `git diff --check`
- `pnpm install --frozen-lockfile`
- `pnpm --filter web typecheck`
- `pnpm lint`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`

### 测试结果

- targeted API tests：通过；44 test files / 510 tests passed。
- `git diff --check`：通过。
- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- `pnpm --filter web typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test:api`：通过；44 test files / 510 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env；39/39 pages generated successfully。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未执行 0044 migration。
- 未触发 checkout / payment / refund / cancel / webhook replay。
- 未做 production smoke。
- 未修改 Vercel / Supabase / Stripe backend/env。
- 未实现 PR3 年付按月释放。
- 未实现会员升级。
- 未进入 PR2.x。

### CI / Security / Vercel 状态

- 本地 gate 已重新通过。
- 等待本 owner-audit fix 2 推送后重新通过 GitHub / Vercel checks，再标记 ready candidate。
- billing 业务代码 PR 不由 Codex merge，必须等待 owner audit。

## PR 2 owner audit fix 3 - positive admin adjustment classification

### 时间

- 执行时间：2026-06-09 CST

### 背景

- PR #230 live GitHub head 已确认不是旧 `dcaa53f866b7952b6b638a3e551e642bd120d0b6`，而是 `64b332ac0d436fe574948a598c45e2e3faba1149`。
- `purchaseCredits` P2 thread 与 manual deduction P2 thread 均已 outdated，但 GitHub 新增 active P2：positive admin adjustments 被 0044 trigger / fallback helper 归为 `grant` / `bonus_grant`。
- 风险：`admin.adjustUserCredits` 正向调整写 `p_type = addition`、`[Admin] ...` description、`admin_adjustment:*` idempotency key；如果先按正数 `addition` 归为 grant，会错误进入 `getCreditsSummary.totalEarned` 和 grant metrics。

### 修复范围

- `packages/api/src/services/creditLedger.ts`
- `apps/web/src/components/profile/creditLedgerPresentation.ts`
- `packages/api/src/routers/credits.test.ts`
- `packages/api/src/services/__tests__/creditLedger.test.ts`
- `packages/api/src/services/__tests__/creditLedgerPresentation.test.ts`
- `packages/db/migrations/0044_credit_transactions_v2_semantics.sql`
- `packages/db/tests/credit_transactions_v2_semantics.sql`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- GitHub issue #225

### 修复行为

- Admin adjustment signal 现在对正负金额都优先于 grant/spend fallback：
  - `source_type = admin`
  - `idempotency_key` 以 `admin_adjustment:` 或 `admin_credit_deduction:` 开头
  - description 含 `管理员` / `admin` / `调整` / `adjustment`
- Positive admin additions 不再归类为 `grant` / `bonus_grant`。
- Positive admin additions 不计入 `countsAsTopupPurchaseCredit`。
- `getCreditsSummary.totalEarned` 只统计 ledger `grant`；positive admin adjustment 进入 `byLedgerType.adjustment`。
- `CreditRecordsCard` presentation helper 同步显示 positive admin adjustment 为“系统调整”。
- 0044 migration source 的 future trigger 同步同一顺序；本次未执行 migration。

### 测试覆盖

- `normalizeCreditLedgerType` 将 `[Admin] manual top-up` + `admin_adjustment:*` 正向 addition 归为 `adjustment`。
- `inferCreditReasonCode` 返回 `admin_adjustment`。
- `countsAsTopupPurchaseCredit` 不统计 positive admin adjustment。
- `getCreditsSummary.totalEarned` 不包含 positive admin adjustment。
- `CreditRecordsCard` 对 positive admin adjustment 显示“系统调整”。
- DB smoke source 覆盖 future 0044 trigger 对 positive admin adjustment 的 adjustment 分类。

### 测试命令

- `pnpm --filter @repo/api test:run -- creditLedger credits billingReconciliation creditLedgerPresentation`
- `git diff --check`
- `pnpm install --frozen-lockfile`
- `pnpm --filter web typecheck`
- `pnpm lint`
- `pnpm test:api`
- `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<dummy> NEXT_PUBLIC_APP_URL=https://example.com OPENROUTER_API_KEY=<dummy> pnpm build`

### 测试结果

- targeted API tests：通过；44 test files / 511 tests passed。
- `git diff --check`：通过。
- `pnpm install --frozen-lockfile`：通过；未产生 tracked package/lockfile 变更。
- `pnpm --filter web typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test:api`：通过；44 test files / 511 tests passed。
- `pnpm build`：通过；使用本地 dummy、非 secret 构建期 env；39/39 pages generated successfully。

### 禁止动作确认

- 未执行 Supabase DB migration。
- 未执行 0044 migration。
- 未触发 checkout / payment / refund / cancel / webhook replay。
- 未做 production smoke。
- 未修改 Vercel / Supabase / Stripe backend/env。
- 未实现 PR3 年付按月释放。
- 未实现会员升级。
- 未进入 PR2.x。

### CI / Security / Vercel 状态

- 本地 gate 已重新通过。
- 等待本 owner-audit fix 3 推送后重新通过 GitHub / Vercel checks，再等待 owner 再次审计。
- billing 业务代码 PR 不由 Codex merge，必须等待 owner audit。

## PR 2 merge record - credit_transactions v2 semantics

### 时间

- Merge gate processed：2026-06-09 CST
- GitHub merged at：2026-06-08T17:50:48Z

### 合并状态

- PR #230：MERGED into `staging`。
- PR head：`9f01280083c7c5af1c2845ba40dcefd273fcc93e`。
- Squash merge commit：`708496962dbf683a28fbbd9feab4d1e8f95fd7d0`。
- Base branch：`staging`。
- PR branch：`codex/billing-v1-pr2-credit-ledger-v2`，merge 后已删除远端分支。
- Merge gate checks：Vercel Preview Comments、`graylum-ai-vercel-v1`、`graylumai-staging` 在 PR head 上均为 success。
- Changed files：仍限于 PR2 credit ledger v2 semantics / billing reconciliation / presentation / tests / 0044 migration source 文件范围。

### Review thread closure

- Positive admin adjustment P2 thread 已回复并标记 resolved。
- Owner audit 已确认修复有效。
- Admin adjustment signal 现在对正负金额均优先于 grant/spend fallback。
- Positive admin adjustment 不计入 grant、`totalEarned`、`purchaseCredits`。
- 对应测试已覆盖。

### 当前阶段

- PR2 状态：`merged`。
- 当前 Billing Engine 阶段：PR2 merged。
- 下一阶段：PR2.x staging DB 0044 migration application / runtime no-payment verification。

### 禁止动作确认

- 未执行 0044 migration。
- 未触发 checkout / payment / refund / cancel / webhook replay。
- 未做 production smoke。
- 未修改 Vercel / Supabase / Stripe backend/env。
- 未进入 PR3。
