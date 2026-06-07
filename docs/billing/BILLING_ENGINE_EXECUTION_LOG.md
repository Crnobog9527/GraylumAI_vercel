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
