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
