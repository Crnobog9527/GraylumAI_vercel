# Staging Reproducibility Runbook

## Purpose

This runbook makes the staging rebuild path reproducible for future dependency,
database, and release validation work. It was created for #148 after the #142
dependency validation sequence showed that staging could be made healthy, but
some database bootstrap, RLS, grants, and non-secret seed steps were still
manual.

Use this document as the owner-facing checklist for rebuilding or auditing
staging. Under AGENTS.md section 3, the agent performs staging rebuild,
migration and seed steps itself after the verification described here. The
REL-1 section records file-built release database prerequisites; it does not
authorize production access, production database writes or production
deployment. Those effects, secrets/credentials, changes to the staging project
bindings and the other items in AGENTS.md section 1 still require Owner
approval.

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
any step points at production or needs an AGENTS.md section 1 item that the
Owner has not approved.

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
5. Verify the platform prerequisites on PostgreSQL 17.
   - Supabase supplies the roles, `auth.uid()`, extensions, and the `extensions`
     and `storage` schemas. The local stand-in is
     `packages/db/tests/baseline/platform-local.sql`; never apply it to staging
     or a release database.
6. Build a fresh empty database from repository files. The agent runs these
   staging writes after steps 1-5 confirm the staging target.
   - Apply `packages/db/baseline/*.sql` in filename order (currently
     `0000_core_prerequisites.sql`), then every file in
     `packages/db/migrations` in filename order.
   - Apply `packages/db/baseline/bridges/<migration filename>.sql`, when present,
     immediately before the migration with the same filename.
   - Baseline and bridges are for empty databases only. For an existing staging
     database, apply only reviewed pending migrations after the before-write
     fingerprint check below; never re-bootstrap it with baseline or bridges.
   - Send each complete SQL file to the server as one string; see REL-1 below.
   - After building, capture a read-only fingerprint and compare it as described
     below before proceeding to seed or smoke checks.
7. Apply non-secret staging seed data.
   - The agent runs this staging write after the step 6 fingerprint comparison
     passes.
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

## File-Built Structure And Fingerprint Checks

`db:push` is retired. `packages/db/schema.ts` is a type reference only. Repository
baseline and migrations define the application structure, including RLS,
grants, functions and triggers. The shared local/CI builder is
`packages/db/tests/baseline/build-from-files.mjs`; its order is platform
prerequisites, baseline, then all migrations with same-name bridges immediately
before their migrations. See [the baseline rules](../../packages/db/baseline/README.md)
and [the engineering requirements](../ENGINEERING.md#数据库文件建库与指纹).

Run the empty-database check locally (local Docker only):

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only
```

Any PR changing structure through a new migration, baseline or bridge must
regenerate and commit `packages/db/tests/baseline/built-fingerprint.json`:

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

CI compares this fingerprint object by object. New migrations must run twice
consecutively at their own position in history without changing the structure
on the second run. The shared builder checks every migration from 0067 on;
any genuine exception needs a documented reason in its `NOT_REPEATABLE` list
and independent review (the list is currently empty).

Before and after a migration application to staging, capture a fresh
catalog-only fingerprint with `packages/db/tests/baseline/fingerprint.sql`
inside a `BEGIN READ ONLY` transaction and end with `ROLLBACK`. From the repository
root, after installing the locked dependencies, use the command below. Supply
`DATABASE_URL` through the confirmed target's private environment; this command
does not load an environment file or print connection details. Set `SNAPSHOT_OUT`
to a new filename for each before/after capture (default: `snapshot.json`); it
refuses to overwrite an existing file. The agent may run it against the
confirmed staging target; any production use requires Owner approval under
AGENTS.md section 1. Use a local database for local validation.

The command reuses the existing CTE and group query from `fingerprint.sql`.
It exports `groups` and per-object `objects`: `acl:` / `defacl:` values remain
verbatim, while all other object definitions become MD5 hashes. It reads only
catalogs, checks read-only mode, rolls back before writing the file, and omits
connection information and business rows from the snapshot and console output.

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

let client;
try {
  if (!process.env.DATABASE_URL) throw new Error('Missing connection configuration');
  const source = readFileSync('packages/db/tests/baseline/fingerprint.sql', 'utf8');
  const marker = source.indexOf('-- FINAL');
  if (marker < 0) throw new Error('Missing fingerprint query boundary');
  const cte = source.slice(0, marker);
  const groupsQuery = source.slice(marker).trim().replace(/;$/, '');
  const sql = `${cte}
    SELECT jsonb_build_object(
      'groups', (${groupsQuery}),
      'objects', (SELECT jsonb_object_agg(k,
        CASE WHEN k ~ '^(acl|defacl):' THEN d
             ELSE md5(coalesce(d, '<null>')) END ORDER BY k)
        FROM grouped)
    ) AS snapshot;`;
  client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const mode = await client.query('SHOW transaction_read_only');
  if (mode.rows[0].transaction_read_only !== 'on') throw new Error('Not read-only');
  const result = await client.query(sql);
  await client.query('ROLLBACK');
  writeFileSync(process.env.SNAPSHOT_OUT || 'snapshot.json',
    JSON.stringify(result.rows[0].snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Read-only fingerprint snapshot written.');
} catch {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error('Snapshot export failed; no successful capture. Check configuration and output filename privately.');
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
JS
```

Compare each exported snapshot against a local file-built database:

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --staging <read-only-snapshot.json>
```

`--staging` reads a snapshot file; it does not connect to staging. Only differences
listed in `packages/db/tests/baseline/expected-differences.json` are allowed.
Merged but unapplied migration objects may be temporarily listed in
`pendingOnStaging`; after application, update the committed
`staging-fingerprint.json` and expected differences in the relevant structure PR.
An unexplained difference blocks the next write; it does not authorize repair.

Seed data is separate. A rebuild must not depend on manual SQL from chat history,
screenshots, or one-off dashboard actions.

## REL-1 File-Built Release Database

These are requirements for a separately approved REL-1 execution, not an
instruction to connect to or write a release database during documentation work.

- Use **PostgreSQL 17**. The built fingerprint, `MAINTAIN` privilege and pinned
  CI PostgreSQL image target version 17.
- A fresh Supabase project supplies platform roles, `auth.uid()`, extensions,
  and the `extensions` and `storage` schemas. Confirm those prerequisites before
  the application SQL runs; the local `platform-local.sql` is a test substitute.
- `rls_auto_enable` and the `ensure_rls` event trigger belong to Supabase project
  settings, outside the repository's application schema. Confirm the intended
  setting separately; never infer it from a successful local replay.
- Apply platform prerequisites → `packages/db/baseline` → all migrations, with
  each same-name bridge immediately before its migration. For **every file**,
  send the entire SQL text to the server in one call (for example `psql -X -c`
  with `ON_ERROR_STOP=1`, or one driver submission). **Do not use `psql -f` or
  split the file into client-interpreted commands**: psql can interpret
  metacommands embedded in file input. This is especially relevant to baseline
  and bridge files outside the append-only migration ledger.
- Migration 0010 creates `pg_cron`; migration **0148 removes it**. Confirm the
  target project permits that sequence before applying SQL. If removal is
  prohibited, stop for an approved resolution rather than skipping or rewriting
  migrations. Ticket auto-close uses the Vercel scheduled task (#506).
- After the build, capture a catalog fingerprint read-only and compare the
  snapshot using the `--local-only --staging <snapshot>` command above against
  the built structure and `expected-differences.json`. Resolve unexplained
  differences before proceeding; a passed build alone does not prove remote
  equivalence or product acceptance.

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

## Phase 3 Non-Secret Baseline Seed

Phase 3 adds an explicit staging seed file:

```text
packages/db/seeds/staging_non_secret_baseline.sql
```

This seed is repo-owned, reviewed SQL for the non-secret readiness baseline. It
is not an automatic migration and is not applied by CI, Vercel, or application
startup. Applying it to staging is a database write that the agent performs
after confirming the staging target and the fingerprint check above.

The seed covers:

- `system_settings`
- `membership_plans`
- `credit_packages`
- `ai_models`

Security boundaries:

- Secrets remain owner-provided and outside the repo.
- `OPENROUTER_API_KEY` remains outside the repo.
- `ai_models.api_key` remains `NULL`.
- Stripe price identifiers remain `NULL` unless the owner supplies
  staging-only values separately.
- Test accounts, account credits, and admin access are outside this baseline
  unless separately approved.
- Real chat and billing smoke are outside this baseline.

After the agent applies the seed to staging, run the read-only
readiness script to confirm counts and posture:

```bash
node scripts/check-staging-db-readiness.mjs --env .env.staging.local --confirm-staging --json
```

The readiness script must remain read-only. Do not use it to apply migrations,
seed data, schema changes, RLS changes, grants, or platform configuration.

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
catalog queries before and after any staging write.

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

## Admin Policy Shape / `is_admin` Decision

The approved #148 direction is to avoid `is_admin` in public or anonymous RLS
policy paths. Public read policies should be explicit active-read policies, for
example active plans, active credit packages, user-facing settings, or active
published content. They should not call helper functions that depend on
privileged admin state.

Authenticated admin-only policies should use a direct, reviewed role/status
shape against `public.profiles` where that does not recurse through the same
table's RLS:

- `p.id = auth.uid()`
- `p.role = 'admin'`
- `p.status = 'active'`

Do not recreate helper-backed admin policies on `public.profiles` itself,
because a direct lookup inside a profiles policy can recurse through profiles
RLS. Runtime admin profile access should remain covered by application-level
admin checks and service-role server paths.

If `public.is_admin()` exists from an earlier migration or manual repair, it
must keep fixed `search_path = public, pg_temp`, remain `SECURITY DEFINER`, and
must not be executable by `PUBLIC`, `anon`, or `authenticated`. `service_role`
execute posture may be present or absent, but any change to that posture needs
owner review. New RLS policies should not depend on `is_admin` without an
explicit architecture review.

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
- Policies referencing `is_admin` count.
- `is_admin` fixed-search-path, security-definer, and client execute posture if
  the helper exists.
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
fresh staging rebuild before any reviewed repair SQL is applied.

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
- Admin policy shape: policy references to `is_admin`, direct admin role policy
  names, and `is_admin` posture if the helper exists.
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
Staging SQL writes, seeds and migrations are done by the agent after this
verification. Production access, secret configuration, changes to the staging
project bindings, production Supabase/Vercel settings, and real chat/billing
smoke still require explicit Owner approval.

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
- Stripe staging readiness passes without live-mode values:

```bash
pnpm stripe:readiness:staging
```

The current staging runtime is the standalone Vercel project `graylumai-staging`
using the Vercel Production environment at
`https://auth-staging.graylum.com` (the old Vercel domain was
removed on 2026-10-01). Its Stripe test-mode webhook endpoint is:

```text
https://auth-staging.graylum.com/api/stripe/webhook
```

The Stripe readiness script loads `.env.staging.local`, refuses production-like
app hosts, defaults to the `auth-staging.graylum.com` staging host, requires
test-mode Stripe keys, checks active plan/package Price ID coverage, and verifies
the referenced Stripe Price objects are readable, active, test-mode, and match
their expected one-time/monthly/yearly usage. It prints only presence flags, safe
mode labels, counts, and masked Stripe identifiers.

If the staging database was cloned from production, replace
`credit_packages.stripe_price_id`,
`membership_plans.stripe_monthly_price_id`, and
`membership_plans.stripe_yearly_price_id` with staging Stripe test-mode Price
IDs before running real billing smoke. Do not reuse production live Price,
Checkout Session, Invoice, Subscription, or Customer identifiers for staging
test-mode smoke.

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
- Staging DB writes are done by the agent after verification; production
  writes require Owner approval.

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
