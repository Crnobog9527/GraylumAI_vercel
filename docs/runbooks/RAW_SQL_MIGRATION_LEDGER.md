# Raw SQL Migration Execution Ledger

## Scope

This document is a docs-only audit index for raw SQL migration execution
evidence. It consolidates evidence that is otherwise split across pull request
bodies, Codex reports, DB execution reports, postflight reports, runtime smoke
reports, and owner-provided release context.

This document is not a DB-level ledger table. It is not a migration. It is not a
production change. It does not execute SQL, connect to Supabase, change staging
or production data, clean `public.prompts`, or modify runtime behavior.

Use this ledger for later audit, rollback reasoning, environment rebuilds, and
staging/production drift review. If evidence is missing, it is marked explicitly
instead of being inferred.

## Evidence Policy

- `verified`: Evidence was found in the repository, migration file, git history,
  PR body, PR comment, or other repo/GitHub-visible report during this pass.
- `owner-provided`: Evidence was provided by the owner in the task context, but
  this pass did not find matching complete repo/GitHub-visible evidence.
- `unknown / evidence missing`: This pass did not find evidence.
- `not found in repo-visible evidence`: The specific field was searched in
  local repo or GitHub-visible PR evidence and not found.
- No inferred facts: a migration being present in git does not prove that it was
  executed in any environment.

## Ledger Summary

| Migration | File | Commit / main SHA | SQL SHA256 | Staging status | Production status | Primary evidence source | Gaps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0037 | `packages/db/migrations/0037_preserve_subscription_status_on_invoice_fulfillment.sql` | `1fe8638e54d1fcb65571d9318e1c25d715ae6e76` | `5e74b8f347221e9ee3d84c92e8828d8f6c7556191bffb4ca59bfdeedb0cc060a` | Direct raw SQL execution: `unknown / evidence missing`; staging behavior evidence: `verified` | `unknown / evidence missing` | PR #187 body, local migration file, git history | Direct execution timestamp/ref missing; production-equivalent function body evidence missing; owner seed is not a complete 64-character SHA256 digest |
| 0038 | `packages/db/migrations/0038_normalize_module_boolean_flags.sql` | `1233a7011405dbc7df5834da8c65967eca7625d0` | `bcb66233ddc2708bb603a64ec17524ac89e4668bde81a2fb8c0b6e51306c183e` | `unknown / evidence missing` | `verified` production-only execution evidence | PR #190 body, local migration file, git history | Staging execution evidence missing; Supabase refs missing; runtime smoke missing |
| 0039 | `packages/db/migrations/0039_normalize_module_policy_shape.sql` | `1233a7011405dbc7df5834da8c65967eca7625d0` | `3dd6747f873f1151bdd60f2f6651e80b69f2499e8b231375cb8a021e293875ae` | `verified`, timestamp/ref missing | `verified` | PR #190 body, local migration file, git history | Staging timestamp missing; Supabase refs missing; runtime smoke missing |
| 0040 | `packages/db/migrations/0040_reconcile_module_public_grants.sql` | `0200a73340b48868255f7c4967fd44cb20cb96a2` | `9e428e558be081a81928b9fa7e91fdb2ea5dfb15bdccbba16e8e0a5fe9a552e0` | `owner-provided`; repo-visible execution evidence not found in PR #203 | `owner-provided`; repo-visible execution evidence not found in PR #203 | PR #203 body for code/change scope; owner-provided task context for execution/postflight/smoke | Execution/postflight/smoke reports not found in PR #203 visible evidence |

## 0037 - Preserve Subscription Status On Invoice Fulfillment

### Identity

- Migration number: `0037`
- Migration file path:
  `packages/db/migrations/0037_preserve_subscription_status_on_invoice_fulfillment.sql`
- Migration title / purpose: preserve Stripe subscription lifecycle status in
  `user_subscriptions.status`; keep invoice payment status on
  `payment_orders.payment_status`.
- Related PR(s): PR #187.
- Related issue(s): `unknown / evidence missing`.
- Commit SHA / main SHA: `1fe8638e54d1fcb65571d9318e1c25d715ae6e76`.
- SQL SHA256, repo-verified:
  `5e74b8f347221e9ee3d84c92e8828d8f6c7556191bffb4ca59bfdeedb0cc060a`.
- Owner seed SHA256:
  `5e74b8f347221e9ee3d84c92e882d8f6c7556191bffb4ca59bfdeedb0cc060a`.
- SHA256 note: the owner-provided seed is not a complete 64-character SHA256
  digest. The repo-verified `sha256sum` above is the canonical local file hash
  for this pass. Do not treat the owner seed as confirmed until separately
  verified.

### Environment Coverage

- Staging Supabase project ref: PR #187 visible evidence only showed a masked
  staging ref; actual ref is `unknown / evidence missing`.
- Production Supabase project ref: `unknown / evidence missing`.
- Staging execution status: direct raw SQL execution is
  `unknown / evidence missing`.
- Production execution status: `unknown / evidence missing`.
- Production-equivalent function body applied evidence:
  `unknown / evidence missing`.
- Staging execution timestamp: `unknown / evidence missing`.
- Production execution timestamp: `unknown / evidence missing`.

### Evidence Sources

- PR #187 body: `verified` for migration purpose and staging billing/runtime
  behavior after the readiness work.
- Local migration file: `verified` for function definition and function execute
  grant posture.
- Git history: `verified` that commit
  `1fe8638e54d1fcb65571d9318e1c25d715ae6e76` added the migration file.
- PR #187 comments/reviews: DB execution report not found.

### Postflight Checks

- Grants / function permission check: partial. The SQL file revokes execute from
  `PUBLIC`, `anon`, and `authenticated`, then grants execute to `service_role`.
  PR #187 visible evidence did not include a concrete permissions postflight
  output.
- Policy check: not applicable to this migration, based on migration purpose.
- Row count check: PR #187 body reports staging billing behavior and no duplicate
  invoice fulfillment; direct row-count postflight output is
  `unknown / evidence missing`.
- Data invariant check: PR #187 body reports one invoice order per invoice and
  fulfillment once for the staging test path.
- Function permission check: partial, detailed output missing.

### Runtime Smoke Evidence

- Staging billing/runtime smoke: `verified` from PR #187 body.
- Production runtime smoke: `unknown / evidence missing`.
- Payment smoke: staging billing/payment path was in PR #187 evidence; this
  ledger PR did not run any payment smoke.

### Data Side Effects / Corrections

- Known data side effects: the migration changes
  `public.atomic_fulfill_membership_invoice` behavior and execute grants.
- Dirty data correction evidence: `unknown / evidence missing`.
- Correction SQL evidence: `unknown / evidence missing`.

### Rollback / Restore Notes

- Rollback / restore evidence: `evidence missing`.
- Function-body restore source would need an owner-authorized audit task if this
  must be reconstructed from live DB state.

### Owner Approval / Decision Evidence

- Owner merge decision: PR #187 was merged by `Crnobog9527`.
- Standalone SQL execution approval evidence: `unknown / evidence missing`.

### Remaining Gaps

- Direct staging raw SQL execution evidence.
- Staging Supabase project ref.
- Staging execution timestamp.
- Production execution evidence.
- Production-equivalent function body applied evidence.
- Concrete function permission postflight output.
- Dirty data correction evidence.
- Rollback / restore notes.

### Explicit Out Of Scope For This PR

- No DB changes in this PR.
- No SQL execution in this PR.
- No production/staging DB access in this PR.
- No prompts cleanup in this PR.

## 0038 - Normalize Module Boolean Flags

### Identity

- Migration number: `0038`
- Migration file path:
  `packages/db/migrations/0038_normalize_module_boolean_flags.sql`
- Migration title / purpose: normalize `public.modules.active` and
  `public.modules.is_featured` to native PostgreSQL boolean fields.
- Related PR(s): PR #190.
- Related issue(s): `unknown / evidence missing`.
- Commit SHA / main SHA: `1233a7011405dbc7df5834da8c65967eca7625d0`.
- Execution head recorded in PR #190 body:
  `c4decc4536d072402ae00fe9413d17f10288af08`.
- SQL SHA256:
  `bcb66233ddc2708bb603a64ec17524ac89e4668bde81a2fb8c0b6e51306c183e`.

### Environment Coverage

- Staging Supabase project ref: `unknown / evidence missing`.
- Production Supabase project ref: `unknown / evidence missing`.
- Staging execution status: `unknown / evidence missing`.
- Production execution status: `verified`, production-only execution evidence in
  PR #190 body.
- Staging execution timestamp: `unknown / evidence missing`.
- Production execution timestamp: PR #190 body records
  `2026-05-26T14:46:35.263Z` to `2026-05-26T14:46:38.173Z`.

### Evidence Sources

- PR #190 body: `verified` production-only execution and postflight evidence.
- Local migration file: `verified` migration content and SQL SHA256.
- Git history: `verified` that commit
  `1233a7011405dbc7df5834da8c65967eca7625d0` added the migration file.
- PR #190 comments/reviews: no separate runtime smoke or staging execution
  evidence found.

### Postflight Checks

- Grants check: PR #190 body records `public.modules` grants unchanged.
- Policy check: migration recreates canonical
  `modules_select_active_public` and `modules_select_admin` policies after
  boolean normalization.
- Row count check: PR #190 body records `public.modules` row count unchanged and
  `public.prompts` row count unchanged.
- Data invariant check: PR #190 body records `active` and `is_featured` as
  boolean, `NOT NULL`, expected defaults, and null count `0`.
- Function permission check: not applicable to this migration.

### Runtime Smoke Evidence

- Runtime smoke evidence: `unknown / evidence missing`.
- Deployment status evidence: Vercel `Ready` comments/checks were visible, but
  those are not runtime smoke evidence.

### Data Side Effects / Corrections

- Known data side effects: production column type/default/nullability
  normalization for `active` and `is_featured`, based on PR #190 body.
- `public.prompts` cleanup: not performed by this migration; PR #190 body records
  prompt row count unchanged.
- Dirty data correction evidence beyond boolean normalization:
  `unknown / evidence missing`.

### Rollback / Restore Notes

- Rollback / restore evidence: `evidence missing`.

### Owner Approval / Decision Evidence

- Owner merge decision: PR #190 was merged by `Crnobog9527`.
- Standalone SQL execution approval evidence: PR #190 body says migrations should
  execute only after separate owner authorization, but a direct approval comment
  was not found in PR #190 visible evidence.

### Remaining Gaps

- Staging execution evidence.
- Staging and production Supabase project refs.
- Runtime smoke evidence.
- Standalone SQL execution approval comment/report.
- Rollback / restore notes.

### Explicit Out Of Scope For This PR

- No DB changes in this PR.
- No SQL execution in this PR.
- No production/staging DB access in this PR.
- No prompts cleanup in this PR.

## 0039 - Normalize Module Policy Shape

### Identity

- Migration number: `0039`
- Migration file path:
  `packages/db/migrations/0039_normalize_module_policy_shape.sql`
- Migration title / purpose: reconcile `public.modules` RLS policy names and
  expressions after boolean flag normalization.
- Related PR(s): PR #190.
- Related issue(s): `unknown / evidence missing`.
- Commit SHA / main SHA: `1233a7011405dbc7df5834da8c65967eca7625d0`.
- Execution head recorded in PR #190 body:
  `c4decc4536d072402ae00fe9413d17f10288af08`.
- SQL SHA256:
  `3dd6747f873f1151bdd60f2f6651e80b69f2499e8b231375cb8a021e293875ae`.

### Environment Coverage

- Staging Supabase project ref: `unknown / evidence missing`.
- Production Supabase project ref: `unknown / evidence missing`.
- Staging execution status: `verified` from PR #190 body.
- Production execution status: `verified` from PR #190 body.
- Staging execution timestamp: `unknown / evidence missing`.
- Production execution timestamp: PR #190 body records
  `2026-05-26T14:18:50.198Z` to `2026-05-26T14:18:53.287Z`.

### Evidence Sources

- PR #190 body: `verified` staging and production execution/postflight evidence.
- Local migration file: `verified` migration content and SQL SHA256.
- Git history: `verified` that commit
  `1233a7011405dbc7df5834da8c65967eca7625d0` added the migration file.
- PR #190 comments/reviews: no separate runtime smoke evidence found.

### Postflight Checks

- Grants check: PR #190 body records `public.modules` grants unchanged.
- Policy check: PR #190 body records canonical
  `modules_select_active_public` and `modules_select_admin` policies present,
  legacy module policies absent, and no `FOR ALL` module policy.
- Row count check: PR #190 body records `public.modules` and `public.prompts`
  row counts unchanged.
- Data invariant check: policy-only migration; PR #190 body records no data
  movement and unchanged row counts.
- Function permission check: not applicable to this migration.

### Runtime Smoke Evidence

- Runtime smoke evidence: `unknown / evidence missing`.
- Deployment status evidence: Vercel `Ready` comments/checks were visible, but
  those are not runtime smoke evidence.

### Data Side Effects / Corrections

- Known data side effects: no row/data changes found in PR #190 evidence; this
  migration is policy-only.
- `public.prompts` cleanup: not performed by this migration; PR #190 body records
  prompt row count/policies unchanged.

### Rollback / Restore Notes

- Rollback / restore evidence: `evidence missing`.

### Owner Approval / Decision Evidence

- Owner merge decision: PR #190 was merged by `Crnobog9527`.
- Standalone SQL execution approval evidence: PR #190 body says migrations should
  execute only after separate owner authorization, but a direct approval comment
  was not found in PR #190 visible evidence.

### Remaining Gaps

- Staging execution timestamp.
- Staging and production Supabase project refs.
- Runtime smoke evidence.
- Standalone SQL execution approval comment/report.
- Rollback / restore notes.

### Explicit Out Of Scope For This PR

- No DB changes in this PR.
- No SQL execution in this PR.
- No production/staging DB access in this PR.
- No prompts cleanup in this PR.

## 0040 - Reconcile Module Public Grants

### Identity

- Migration number: `0040`
- Migration file path:
  `packages/db/migrations/0040_reconcile_module_public_grants.sql`
- Migration title / purpose: grants-only reconciliation for
  `public.modules` anon/authenticated access.
- Related PR(s): PR #203.
- Related issue(s): `unknown / evidence missing`.
- PR #203 head SHA: `30c723c5c9a93500149554387f8e4b39dc296cc8`.
- Commit SHA / main SHA: `0200a73340b48868255f7c4967fd44cb20cb96a2`.
- SQL SHA256:
  `9e428e558be081a81928b9fa7e91fdb2ea5dfb15bdccbba16e8e0a5fe9a552e0`.

### Environment Coverage

- Staging Supabase project ref: `gvcpmcunmfrbxuwimxfa`
  (`owner-provided`; repo-visible evidence not found in PR #203).
- Production Supabase project ref: `fhmshnqjjnnlvplojktv`
  (`owner-provided`; repo-visible evidence not found in PR #203).
- Production app host: `app.graylum.com`
  (`owner-provided`; repo-visible evidence not found in PR #203).
- Staging execution status: `owner-provided` executed; repo-visible execution
  report not found in PR #203 body/comments/reviews.
- Production execution status: `owner-provided` executed; repo-visible execution
  report not found in PR #203 body/comments/reviews.
- Staging execution timestamp: `unknown / evidence missing`.
- Production execution timestamp: `2026-05-28T09:29:02.676Z` to
  `2026-05-28T09:29:03.009Z` (`owner-provided`; repo-visible evidence not found
  in PR #203).

### Evidence Sources

- PR #203 body: `verified` for docs/code scope, migration path, no in-PR SQL
  execution, and post-merge execution checklist. It is not execution evidence.
- Local migration file: `verified` migration content and SQL SHA256.
- Git history / PR metadata: `verified` PR #203 merge/main SHA and merge by
  `Crnobog9527`.
- Owner-provided task context: staging/production execution, postflight, and
  runtime no-payment smoke details.
- PR #203 comments/reviews: staging/production execution reports, postflight
  reports, runtime smoke reports, environment refs, and production execution
  timestamp were not found.

### Postflight Checks

- Staging grants check: `owner-provided` pass. Anon/authenticated have no
  `public.modules` table-level grants, only canonical public display column
  `SELECT`, no sensitive/internal `SELECT`, and no column-level
  `INSERT`/`UPDATE`/`REFERENCES`.
- Production grants check: `owner-provided` pass. Anon/authenticated have no
  `public.modules` table-level grants, no column-level
  `INSERT`/`UPDATE`/`REFERENCES`, only 23 canonical public display column
  `SELECT`, and no sensitive/internal `SELECT`.
- Policy check: `owner-provided` pass. Policies remained
  `modules_select_active_public` and `modules_select_admin` in staging and
  production.
- Row count check: `owner-provided` pass. `public.prompts` row count remained
  `0` in staging and `20` in production.
- Data invariant check: migration is grants-only by file content; owner-provided
  evidence says no prompt cleanup occurred.
- Function permission check: not applicable to this migration.

### Runtime Smoke Evidence

- Staging no-payment smoke: `owner-provided` pass. Unauthenticated marketplace,
  chat, pricing, and legal pages were normal; no login, AI, checkout, webhook,
  SQL, or DB writes were triggered.
- Production no-payment smoke: `owner-provided` pass for `www.graylum.com`,
  `graylum.com`, and `app.graylum.com`.
- Production public modules tRPC: `owner-provided` pass.
  `modules.getModules` returned HTTP `200`, `8` modules, and no sensitive key.
  `modules.getFeaturedModules` returned HTTP `200`, `2` featured modules, and
  no sensitive key.
- Payment smoke: not performed; pricing CTA was only verified before payment
  boundary.
- AI smoke: not performed; `/api/ai` and `/api/ai/stream` were not triggered.
- Runtime smoke report in PR #203 visible evidence: not found.

### Data Side Effects / Corrections

- Known data side effects: no data changes in the migration file; owner-provided
  postflight says prompt row counts remained unchanged.
- `public.prompts` cleanup: explicitly not performed.
- Dirty data correction evidence: not applicable / evidence missing.

### Rollback / Restore Notes

- Rollback / restore evidence: `evidence missing`.
- A restore plan would need owner-authorized audit work and should not be
  inferred from this docs-only ledger.

### Owner Approval / Decision Evidence

- Owner merge decision: PR #203 was merged by `Crnobog9527` at
  `2026-05-28T08:37:59Z`.
- Standalone SQL execution approval evidence in PR #203:
  `unknown / evidence missing`.
- Owner task context states staging and production execution completed and P1
  grants repair is closed; this pass did not find matching complete
  repo/GitHub-visible execution reports in PR #203.

### Remaining Gaps

- Repo/GitHub-visible staging DB execution report.
- Repo/GitHub-visible production DB execution report.
- Repo/GitHub-visible staging postflight report.
- Repo/GitHub-visible production postflight report.
- Repo/GitHub-visible runtime no-payment smoke report.
- Staging execution timestamp.
- Rollback / restore notes.

### Explicit Out Of Scope For This PR

- No DB changes in this PR.
- No SQL execution in this PR.
- No production/staging DB access in this PR.
- No prompts cleanup in this PR.

## Out Of Scope For This Docs-Only PR

- No DB SQL executed by this PR.
- No production or staging DB access by this PR.
- No migration SQL modified.
- No runtime code modified.
- No API, UI, billing, auth, AI, checkout, or webhook logic modified.
- No tests modified.
- No `public.prompts` cleanup.
- No Vercel project, Vercel settings, Vercel environment variable, Stripe,
  environment variable, or project setting changes.
- Any Vercel preview deployment or status check was automatic from the PR
  workflow and was not a production/staging runtime smoke.
- No checkout session created.
- No AI call triggered.
- No webhook triggered.
- No login flow triggered.
- No production smoke or staging smoke run by this PR.
- No #190 review thread handling.
- No Dependabot handling.
- No PR merge by Codex.

## Remaining Gaps And Follow-Up

These gaps should not be filled in this PR by connecting to a database or
running SQL. If they need closure, they require a separate owner-authorized
audit task.

- 0037: direct staging execution evidence, staging ref, execution timestamp,
  production-equivalent function body evidence, concrete function permission
  postflight output, dirty data correction evidence, rollback notes, and review
  of the incomplete owner-provided SHA256 seed.
- 0038: staging execution evidence, staging/production refs, runtime smoke,
  direct SQL authorization evidence, and rollback notes.
- 0039: staging execution timestamp, staging/production refs, runtime smoke,
  direct SQL authorization evidence, and rollback notes.
- 0040: repo/GitHub-visible DB execution reports, postflight reports, runtime
  smoke reports, staging execution timestamp, direct SQL authorization evidence,
  and rollback notes.
