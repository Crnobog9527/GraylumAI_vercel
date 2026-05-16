# Staging Reproducibility Runbook

## Purpose

This runbook makes the staging rebuild path reproducible for future dependency,
database, and release validation work. It was created for #148 after the #142
dependency validation sequence showed that staging could be made healthy, but
some database bootstrap, RLS, grants, and non-secret seed steps were still
manual.

Use this document as the owner-facing checklist for rebuilding or auditing
staging. Do not use it as a production procedure.

## Scope

This runbook covers:

- Staging database bootstrap order.
- RLS, grants, and RPC/function readiness.
- Non-secret staging seed categories.
- Sanitized verification checks.
- Anonymous, auth/admin, and chat/billing smoke prerequisites.

This runbook does not cover:

- Production database changes.
- Storing secrets in the repo.
- Real chat/billing smoke without explicit owner approval.
- Applying SQL writes without a reviewed implementation plan.
- Replacing future idempotent migrations, seed scripts, or verification scripts.

## Current Known Baseline

At the time this runbook was introduced:

- #145 Supabase client / SSR upgrade was completed.
- #146 tRPC upgrade was completed.
- #147 drizzle-kit upgrade was completed.
- #142 was closed as completed.
- #148 tracks staging DB bootstrap, RLS, seed, and smoke reproducibility.
- `main` and `staging` were synchronized.
- Real staging chat/billing smoke had passed once with a staging-only setup.
- Some DB/RLS/seed work required manual staging repair, so future rebuilds need
  a repo-owned process instead of relying on chat history.

## Fresh Staging Rebuild Order

Use this order for a fresh staging rebuild or a staging drift recovery. Stop if
any step points at production or requires unapproved writes.

1. Confirm the Git baseline.
   - `main` and `staging` should be synchronized for the intended release point.
   - Open PR count should match the current release plan.
   - The working tree should be clean before any rebuild work starts.
2. Create or verify the Supabase staging project.
   - Confirm the project is the staging project, not production.
   - Confirm only safe metadata is reported: host name, project ref, and
     variable presence yes/no.
3. Create or verify the Vercel staging project.
   - Confirm Branch Tracking points at `staging`.
   - Confirm the staging deployment is separate from production.
4. Configure owner-provided secrets manually.
   - Do not commit, paste, or log secret values.
   - Codex may only report variable presence yes/no and safe host/ref metadata.
5. Run the schema push against staging.
   - `db:push` updates schema shape from Drizzle.
   - It is not a complete staging bootstrap by itself.
6. Apply raw SQL migrations or future bootstrap SQL against staging only.
   - This step requires explicit owner approval because it writes to the DB.
   - Prefer reviewed, idempotent repo-owned SQL over ad-hoc SQL copied from
     chat history.
7. Apply non-secret staging seed data.
   - This step requires explicit owner approval because it writes to the DB.
   - Seeds must be idempotent and must not contain real API keys or production
     billing identifiers.
8. Verify RLS, grants, and RPC/function readiness.
   - Prefer read-only catalog queries or a future read-only verification script.
   - Report only counts, object names, policy names, grant summaries, and
     yes/no checks.
9. Verify anonymous pages.
   - `/login`
   - `/landing`
   - `/faq`
   - `/marketplace` unauthenticated redirect
10. Verify auth/admin smoke.
    - Normal user login/logout.
    - Protected route redirect after logout.
    - Admin login and `/admin`.
    - Expected tRPC calls return 200.
11. Verify chat/billing readiness.
    - Provider key presence: yes/no only.
    - Active model, plan, package, and billing-setting counts.
12. Run real chat/billing smoke only after explicit owner approval.
    - This sends a real AI message.
    - This writes chat, billing, and user-data evidence rows.
    - This can spend provider credits.

## Why `db:push` Alone Is Not Enough

The root `db:push` script runs Drizzle schema push. It is useful for schema
shape, but it is not the whole database readiness story.

Raw SQL migrations contain important behavior that schema push does not fully
represent:

- RLS enablement and policies.
- Grants and role-specific access posture.
- `SECURITY DEFINER` RPC/functions.
- Atomic billing/finalize functions.
- Payment, invitation, and credit ledger helpers.
- Supabase Security Advisor hardening.

Seed data is separate as well. A staging rebuild must not depend on manual SQL
from chat history, screenshots, or one-off dashboard actions.

## Required Non-Secret Staging Seed Categories

Future seed work should define categories first, then implement idempotent seed
logic in a later phase. The repo may contain non-secret defaults only.

Required categories:

- `system_settings`
- `membership_plans`
- `credit_packages`
- `ai_models` with `api_key` set to NULL
- Test profiles or credits only when owner-created and explicitly approved

Do not store:

- Production Stripe IDs.
- Production OpenRouter keys.
- Real provider API keys.
- Supabase service-role keys.
- Auth tokens, cookies, or E2E passwords.
- User emails or user IDs from live data.

If an environment-specific billing identifier is needed, keep it as an
owner-provided value outside the repo.

## Owner-Provided Secrets

These values must remain owner-managed and must never be committed, pasted into
issues, or printed in logs:

- `OPENROUTER_API_KEY`
- Supabase service role key
- `DATABASE_URL`
- E2E passwords
- Auth tokens and cookies
- Stripe live identifiers or other production billing credentials

Codex may only report safe metadata:

- Variable present: yes/no.
- Staging host name.
- Supabase project ref.
- Staging versus production classification.

## RLS, Grants, And RPC Reproducibility Checklist

Future implementation phases should verify this checklist with read-only
catalog queries before and after any approved staging write.

RPC/functions:

- `atomic_pre_deduct`
- `atomic_settle`
- `atomic_refund`
- `atomic_abort_settle`
- `atomic_finalize_ai_success`
- `atomic_finalize_ai_failure`
- `atomic_finalize_ai_abort`
- `atomic_apply_invitation_rebate`
- `atomic_apply_credit_ledger_entry`
- `atomic_claim_invitation_code`
- `atomic_fulfill_credit_package`
- `atomic_fulfill_membership_invoice`
- `validate_invitation_code`
- `is_admin` decision and final owner-approved posture

Policies and grants:

- `conversations` INSERT own-row policy.
- `conversations` UPDATE own-row policy.
- `token_stats` authenticated own-read policy and SELECT grant.
- `ai_models` authenticated active-read policy.
- `membership_plans` public active-read policy.
- `credit_packages` public active-read policy.
- `system_settings` user-facing read policy.
- Service-only execute posture for privileged atomic functions.
- Client-role grant hardening for table privileges that should not be exposed.

## Verification Checklist

Verification should prefer read-only commands and sanitized output.

Required checks:

- Current branch and clean git status.
- `origin/main...origin/staging` count.
- Open PR count.
- #148 state.
- #142 state when relevant to dependency completion history.
- Staging host classification.
- Supabase project ref.
- Active `ai_models` count.
- Active `membership_plans` count.
- Active `credit_packages` count.
- Billing-related `system_settings` count.
- Required function existence count.
- RLS policy names on key tables.
- Grant summary for `anon`, `authenticated`, and `service_role`.
- Secret exposure check: no secret values printed.

Output must avoid:

- Full connection strings.
- API keys.
- Service role keys.
- Auth tokens.
- Cookies.
- User emails.
- User IDs from live data.

## Read-Only Readiness Script

Use the Phase 2A readiness script when auditing staging drift or checking a
fresh staging rebuild before any approved repair SQL is applied.

```bash
node scripts/check-staging-db-readiness.mjs --env <staging-env-file> --confirm-staging
```

Optional JSON output:

```bash
node scripts/check-staging-db-readiness.mjs --env <staging-env-file> --confirm-staging --json
```

Required environment values:

- `DATABASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_APP_URL`

Optional safety expectations:

- `EXPECTED_SUPABASE_PROJECT_REF`
- `EXPECTED_APP_HOST`

The script requires `--confirm-staging` before it attempts a database
connection. It refuses production-like targets by default, including the known
production app host and hosts with production-like naming. If a target cannot be
classified as staging, stop and investigate instead of overriding the guard.

The script is read-only. It runs catalog and count queries inside a
`BEGIN READ ONLY` transaction, verifies `transaction_read_only = on`, and rolls
back before exiting. It does not apply migrations, seed data, schema changes,
RLS changes, grants, or RPC calls that mutate data.

The script checks:

- Staging app host, Supabase host, Supabase project ref, and DB host metadata.
- Required RPC/function existence and execute posture.
- RLS enablement, policy names, and role grant summaries for key tables.
- Active `ai_models`, `membership_plans`, and `credit_packages` counts.
- `system_settings` and billing-related `system_settings` counts.
- `ai_models` rows with non-null `api_key` as a count only.
- Drift categories such as missing functions, disabled RLS, missing policies,
  client-role grants to review, and missing readiness seed counts.

Safe output includes only sanitized metadata: host names, project ref, counts,
object names, policy names, grant summaries, and yes/no status. It must never
print full connection strings, key values, auth tokens, cookies, passwords,
user emails, user IDs from live data, or provider secrets.

Exit codes:

- `0`: readiness is acceptable for the documented baseline.
- `1`: readiness gaps were found and need a reviewed follow-up plan.
- `2`: safety violation, production-like target, missing required environment,
  or query failure.

Readiness gaps are not automatically repaired by this script. Missing RPCs,
policies, grants, or seed counts should feed the next reviewed #148 phase.
Any SQL write, seed, migration, Supabase/Vercel setting change, secret
configuration, or real chat/billing smoke still requires explicit owner
approval.

## Smoke Checklist

Keep smoke checks separated by write risk.

Anonymous smoke:

- `/login`
- `/landing`
- `/faq`
- `/marketplace` redirects unauthenticated users to login
- No maintenance mode
- No 500s
- No redirect loops
- No blocking runtime errors

Auth/admin smoke:

- Normal user login.
- Normal user app/profile page loads.
- Normal user logout.
- Protected route after logout redirects to login.
- Admin login.
- `/admin` loads.
- `settings.getSystemSettings` returns 200.
- `user.getUserProfile` returns 200.
- `credits.getBalance` returns 200.
- `admin.getStatistics` returns 200.

Chat/billing readiness:

- Provider key present: yes/no only.
- Active AI model count is greater than 0.
- Active membership plan count is greater than 0.
- Active credit package count is greater than 0.
- Billing-related settings are present.

Real chat/billing smoke:

- Requires explicit owner approval.
- Sends a real AI message.
- Writes chat, billing, and user-data evidence rows.
- Can spend provider credits.
- Should preserve a requestId evidence chain across runtime response, usage
  logs, conversation/message persistence, token stats, and credit balance
  changes.
- Abort/refund smoke is separate and higher risk.

## Stop Conditions

Stop immediately and report if any of these occur:

- Production host or production project detected.
- Required owner-provided secret is missing.
- Active `ai_models` count is 0 when chat/billing smoke is requested.
- Required atomic RPC/function is missing.
- RLS or grant posture does not match the expected checklist.
- High or critical audit finding appears.
- A command would perform unexpected DB writes.
- A billing anomaly appears.
- Codex sees or might print a secret.
- A command requests destructive migration confirmation.
- A runbook step requires Phase 2 work before Phase 1 approval.

## Follow-Up Implementation Phases

Phase 1: runbook.

- Add the owner-facing staging reproducibility runbook.
- Keep it docs-only.

Phase 2: migration/RPC/RLS reconciliation.

- Add reviewed, idempotent SQL for missing or drifted repo-covered functions,
  RLS, grants, and hardening.
- Requires owner approval before any DB write.

Phase 3: seed strategy.

- Add non-secret, idempotent staging seed strategy for required readiness rows.
- Keep real secrets and production billing identifiers out of the repo.

Phase 4: verification script.

- Add a read-only readiness check that refuses production and prints only
  sanitized metadata.

Phase 5: repeatable chat/billing smoke runbook.

- Document the approved staging-only real smoke flow, evidence chain,
  provider-spend boundary, and recovery path.

## Related Issues And PRs

- #142: Dependency task split and validation.
- #145: Supabase client / SSR upgrade.
- #146: tRPC upgrade.
- #147: drizzle-kit upgrade.
- #148: Staging DB bootstrap, RLS, seed, and smoke reproducibility.
