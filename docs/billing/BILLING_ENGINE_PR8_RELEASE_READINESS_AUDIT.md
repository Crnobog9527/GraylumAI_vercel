# Billing Engine v1.5 PR8 Release Readiness Audit

> Execution time: 2026-06-17 15:15:37 CST
> Scope: PR8 post-PR7 release-readiness and staging-to-main preparation audit.
> Base branch: `staging`
> Starting staging SHA: `bf90d2a646f161d0460e7addb1138df1b8b7eb42`
> Control Plane issue: #225

## Status

- PR8 stage: `in_progress`.
- PR7 status: `merged / #239`.
- PR #239 merge commit: `bf90d2a646f161d0460e7addb1138df1b8b7eb42`.
- Issue #225 status: open.
- Existing PR8 branch before this run: not found.
- Existing PR8 PR before this run: not found.
- Current PR8 branch: `codex/billing-v1-pr8-release-readiness`.
- Current PR8 PR: #240 / draft.
- PR8 stage: `ready_for_owner_audit`.

## Allowed Scope

- Release-readiness audit and documentation.
- Source-code, docs, tests, and staging-safe changes only.
- PR7 residual review-thread reconciliation.
- Automatic P1/P2 fixes inside PR8 scope.
- Local validation and latest-head Codex review request.
- Draft PR to `staging`.

## Forbidden Scope

- No merge.
- No production release or production smoke.
- No Supabase production DB access.
- No DB migration, RPC migration, RLS, schema, or grant changes.
- No Stripe live behavior.
- No real checkout, payment, refund, cancel, or webhook replay.
- No Vercel, Supabase, or Stripe env / Project Settings changes.
- No `apps/web/vercel.json` changes.
- No cron enablement.
- No PR9.
- No issue #225 closure.

## Live Checkpoint

- `git fetch --all --prune`: completed.
- `origin/main`: `e831609fcd06f714640df9099645bb1d5363790a`.
- `origin/staging`: `bf90d2a646f161d0460e7addb1138df1b8b7eb42`.
- Merge base: `5368f65bd512acb5ac2759930ee49334ce41e77d`.
- Ahead / behind: main-only `5`, staging-only `35`.
- State: `origin/main` and `origin/staging` are diverged.

## PR7 Residual Review Reconciliation

PR #239 is merged, but live review threads still contain unresolved residual comments. Most current-line residuals were already addressed in the merged PR7 code and tests:

- Payment-attention subscription rows are counted for duplicate managed-subscription detection.
- Credit idempotency duplicate checks are scoped by `(user_id, idempotency_key)`.
- Pending subscription grant reversals do not let webhook audit metadata mask missing terminal refund reversal state.
- Missing annual release periods are audited against current invoice scope.
- Grant transactions must match the subscription grant user.
- Truncated grant / ledger scans do not run exhaustive cross-table assertions.

One latest current-line P2 remained actionable:

- P2: `Skip zero-credit annual periods in readiness`.
- Live thread: PR #239 review thread on `packages/api/src/services/billingReconciliation.ts`.
- Finding: readiness due-period calculation required every elapsed annual period even when the production release schedule would grant `0` credits and `grantSubscriptionCredits()` would intentionally skip the row.
- PR8 fix: readiness now loads `membership_plans.yearly_credits`, uses the same annual release schedule helper as production, and filters due periods to `creditsGranted > 0`.
- Regression coverage: added tests for `yearly_credits < 12` and `yearly_credits = 0`.

PR8 latest-head review follow-up:

- P2: `Do not clamp invalid yearly credit schedules`.
- Finding: readiness was normalizing negative `yearly_credits` to `0`, while the production annual-release helper rejects negative schedules.
- PR8 fix: readiness preserves the integer schedule value and reports `annual_monthly_release_plan_schedule_invalid` for active annual subscriptions whose plan has negative `yearly_credits`.
- Regression coverage: added a negative yearly-credit schedule test.

Current PR8 conclusion: no known current-head PR7 residual P1/P2 remains after this PR8 fix. The final latest-head Codex review result is tracked in PR #240 live metadata to avoid creating an extra metadata-only commit after the reviewed head.

## Main / Staging Divergence

Main-only commits:

- `e831609` `[codex] Release #221 monitoring tunnel proxy fix to main`
- `3745865` `[codex] Release #218 membership eligibility guard to main`
- `68793ef` `fix(billing): reconcile Stripe refunds and subscription cancellations (#206)`
- `a732e40` `fix(web): initialize Sentry for main App Router`
- `cedaf71` `release: promote staging logo refresh`

Staging-only commits include Billing Engine v1.5 PR0 through PR7 plus staging-only Sentry/logo/proxy work:

- PR7: `bf90d2a` / #239
- PR6: `e6dc6d7` / #237
- PR5: `0c982e2` / #236
- PR4: `e45e090` / #235
- PR3.x: `395976b`, `37798c8`
- PR3: `4d0cc1c` / #232
- PR2.x: `a61da58`, `c5495e1`
- PR2: `7084969` / #230
- PR1: `8beed4c` / #227
- Control-plane / blueprint / baseline: #223, #224, #226, #229

Staging-only billing surfaces include:

- `docs/billing/BILLING_ENGINE_V1_5_BLUEPRINT.md`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`
- `apps/web/src/app/api/cron/billing-reconcile/route.ts`
- `apps/web/src/app/api/cron/release-subscription-credits/route.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts`
- `apps/web/src/components/profile/*`
- `packages/api/src/routers/admin.ts`
- `packages/api/src/routers/credits.ts`
- `packages/api/src/routers/payments.ts`
- `packages/api/src/routers/user.ts`
- `packages/api/src/services/billingReconciliation.ts`
- `packages/api/src/services/creditLedger.ts`
- `packages/api/src/services/membershipEligibility.ts`
- `packages/api/src/services/paymentOrderStatus.ts`
- `packages/api/src/services/stripeFulfillment.ts`
- `packages/api/src/services/subscriptionCreditGrants.ts`
- `packages/api/src/services/subscriptionPlanChangeLock.ts`
- `packages/db/migrations/0043_payment_order_status_machine.sql`
- `packages/db/migrations/0044_credit_transactions_v2_semantics.sql`
- `packages/db/migrations/0045_subscription_credit_grants.sql`

Main-only billing / shared surfaces include:

- `apps/web/src/app/api/stripe/webhook/route.ts`
- `packages/api/src/routers/payments.ts`
- `packages/api/src/services/membershipEligibility.ts`
- `packages/api/src/services/stripeFulfillment.ts`
- `packages/db/schema.ts`
- `packages/db/tests/atomic_reconcile_stripe_refund.sql`

## Release Blocker: Future Staging To Main Merge Conflicts

Read-only command:

```bash
git merge-tree --write-tree origin/main origin/staging
```

Result: failed with conflicts. No merge was performed.

Predicted conflict files:

- `apps/web/src/app/api/stripe/webhook/route.ts`
- `packages/api/src/routers/payments.test.ts`
- `packages/api/src/routers/payments.ts`
- `packages/api/src/services/__tests__/membershipEligibility.test.ts`
- `packages/api/src/services/__tests__/stripeFulfillment.test.ts`
- `packages/api/src/services/index.ts`
- `packages/api/src/services/membershipEligibility.ts`
- `packages/api/src/services/stripeFulfillment.ts`
- `packages/db/schema.ts`
- `packages/db/tests/atomic_reconcile_stripe_refund.sql`

Conclusion: staging is not ready for an automatic or low-risk direct promotion into `main`. A separately authorized staging-to-main release PR must resolve these conflicts explicitly.

## Changed Files In PR8

- `packages/api/src/services/billingReconciliation.ts`
- `packages/api/src/services/__tests__/billingReconciliation.test.ts`
- `docs/billing/BILLING_ENGINE_PR8_RELEASE_READINESS_AUDIT.md`
- `docs/billing/BILLING_ENGINE_EXECUTION_LOG.md`

## Validation

Completed:

- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `pnpm --filter @repo/api exec vitest run src/services/__tests__/billingReconciliation.test.ts`: passed; 1 file / 26 tests.
- `git diff --check`: passed.
- `pnpm --filter @repo/api exec vitest run src/services/__tests__/billingReconciliation.test.ts src/services/__tests__/creditLedger.test.ts src/services/__tests__/paymentOrderStatus.test.ts src/services/__tests__/membershipEligibility.test.ts src/services/__tests__/subscriptionCreditGrants.test.ts src/services/__tests__/stripeFulfillment.test.ts src/services/__tests__/stripeWebhookRoute.test.ts src/routers/payments.test.ts`: passed; 8 files / 162 tests.
- `pnpm test:api`: passed; 48 files / 621 tests.
- `pnpm lint`: passed.
- `pnpm --filter web typecheck`: passed.
- P2 follow-up targeted readiness test after negative schedule fix: passed.
- Vercel Preview Comments: success.
- Vercel `graylum-ai-vercel-v1`: success.
- Vercel `graylumai-staging`: success.

Latest-head Codex review:

- Review result at finalization: clean; no major issues found.
- Exact reviewed commit and review/comment URL: recorded in PR #240 body and issue #225 live update.
- Unresolved actionable P1/P2 count after latest-head review: `0` known.

## Staging Verification

Vercel preview/staging deployment checks passed for PR #240. No manual browser smoke or runtime cron/payment verification was performed in this checkpoint. PR8 has not enabled cron, has not modified Vercel settings, and has not performed production or payment actions.

## Stop Point

PR8 is `ready_for_owner_audit` on draft PR #240. Stop here; do not merge, do not promote to production, do not enter PR9, and do not close issue #225.
