# STG-FIX structure-comparison evidence record

Status: `REPOSITORY_CANDIDATE_TEMPLATE_ONLY`

This file records the repository-derived expected structure and the exact
future fingerprint protocol for the STG-FIX candidate. It is not a staging or
production readout. No database connection, Supabase query, structure
fingerprint, migration application, or production read occurred while creating
or remediating this record.

## Binding

| Field | Value |
| --- | --- |
| Task Issue | #322 |
| Contract | `STG-FIX-ISSUE-322-C1` |
| Owner preparation gate | Issue #322 comment `5308738373` |
| Remediation V2 gate | Issue #322 comment `5312811024` |
| Audited staging base | `0cfe8e09eb90a2238ada5c7d9ed8a564d46d280b` |
| Main ref at task materialization | `ecf4c6a347038f9352477a98d4171a8ef00c85de` |
| STG-FIX specification blob | `96806c8ce0baac0e85ebb462a17b53f04963de9a` |
| Candidate migration | `packages/db/migrations/0048_restore_staging_baseline_objects.sql` |

The hashes above bind the repository candidate lineage only. Every later
database/read gate must fresh-read current repository refs and must fail closed
if its own required bindings drift.

## Repository-derived expected structure

The following expectations are derived only from the authoritative staging
repository history. They are not claims about either live database.

### `public.claim_daily_checkin(uuid)`

- Final function-definition source:
  `packages/db/migrations/0027_balance_write_surface_lockdown.sql`.
- Signature: `public.claim_daily_checkin(uuid)`.
- `SECURITY DEFINER`, `LANGUAGE plpgsql`, and
  `SET search_path = public, pg_temp`.
- Return columns: `already_claimed`, `checkin_date`, `streak_day`,
  `reward_credits`, `monthly_bonus_credits`, `total_reward_credits`, and
  `monthly_checkin_count`.
- Direct authenticated calls must match `auth.uid()` and `p_user_id`.
- Explicit repository-defined function ACL posture:
  `PUBLIC`, `anon`, and `authenticated` are revoked first; `EXECUTE` is then
  granted to `authenticated` and `service_role`.

### `public.application_logs`

- Table definition source:
  `packages/db/migrations/0006_application_logs.sql`.
- Later index source:
  `packages/db/migrations/0007_performance_indexes.sql`.
- Later policy hardening:
  `packages/db/migrations/0015_security_advisor_hardening.sql`.
- Columns/checks: UUID primary key, level/category checks, message, JSONB
  context, nullable profile foreign key with `ON DELETE SET NULL`, request ID,
  and non-null timestamp.
- Complete expected `pg_indexes` comparison set is **ten** entries, including
  the PostgreSQL PRIMARY KEY backing index created by the inline primary key:
  - `application_logs_pkey`
  - `idx_application_logs_user_id`
  - `idx_application_logs_created_at`
  - `idx_application_logs_category`
  - `idx_application_logs_level`
  - `idx_application_logs_request_id`
  - `idx_application_logs_user_created`
  - `idx_application_logs_level_created`
  - `idx_application_logs_context`
  - `idx_application_logs_created`
- `application_logs_pkey` is part of the same comparison domain returned by the
  future `pg_indexes` query and must not be treated as extra drift.
- Both `idx_application_logs_created_at` and `idx_application_logs_created`
  intentionally resolve to `created_at DESC`; they are distinct names present
  in repository migration history.
- RLS is enabled.
- Expected repository-defined policies are `Admin can view all logs` and
  `Users can view own logs`.
- `Service can insert logs` is intentionally not restored because migration
  `0015_security_advisor_hardening.sql` removes it.

### `public.diagnostic_results`

- Table/enum/index sources:
  `packages/db/migrations/0005_diagnostics.sql`.
- Later policy hardening:
  `packages/db/migrations/0015_security_advisor_hardening.sql`.
- Expected enum labels:
  - `public.diagnostic_status`:
    `passed`, `failed`, `warning`, `skipped`, `error`
  - `public.diagnostic_category`:
    `ai`, `billing`, `security`, `performance`, `data`
- Columns/checks: UUID primary key, test ID/name, the two enums, message, JSONB
  details, latency, nullable profile foreign key, `manual|cron|ci` run type,
  batch ID, and non-null timestamp.
- Complete expected `pg_indexes` comparison set is **six** entries, including
  the PostgreSQL PRIMARY KEY backing index created by the inline primary key:
  - `diagnostic_results_pkey`
  - `idx_diagnostic_results_batch_id`
  - `idx_diagnostic_results_test_id`
  - `idx_diagnostic_results_category`
  - `idx_diagnostic_results_status`
  - `idx_diagnostic_results_created_at`
- `diagnostic_results_pkey` is part of the same comparison domain returned by
  the future `pg_indexes` query and must not be treated as extra drift.
- The similarly named `diagnostics_results` conditional block in migration
  `0007_performance_indexes.sql` targets a different table identity and does
  not alter the expected `diagnostic_results` index set.
- RLS is enabled.
- Expected repository-defined policies are
  `Admins can view all diagnostic results` and
  `Admins can insert diagnostic results`.
- `Service can insert diagnostic results` is intentionally not restored because
  migration `0015_security_advisor_hardening.sql` removes it.

For both target tables, expected-set membership is evaluated over the complete
rows returned by `pg_indexes`. The index names above define required membership,
but future evidence must retain and compare the raw `indexdef` for every row as
well as `indexname`. No legitimate extra index may be discarded to force a
match, and PRIMARY KEY backing indexes are not excluded from the comparison
domain.

## Table-grant posture: unresolved, fail closed

`TABLE_GRANT_EXPECTATION_FROM_REPOSITORY: UNRESOLVED_FAIL_CLOSED`

The repository establishes role-specific RLS/policy intent for
`application_logs` and `diagnostic_results`, but the reviewed repository
migration history does not deterministically bind the complete hosted table ACL
or the database-level default privileges that may have existed when those
tables were created.

In particular:

- `0005_diagnostics.sql` and `0006_application_logs.sql` create the tables and
  policies but do not encode a complete explicit table `GRANT`/`REVOKE` set.
- `0015_security_advisor_hardening.sql` removes the blanket service policies; it
  does not define a complete table ACL for these tables.
- later explicit grant-hardening migrations such as `0029`, `0034`, `0046`,
  and `0047` bind grants for other named tables/surfaces and do not establish a
  complete ACL for these two tables.
- no repository binding is being treated as proof of hosted
  `ALTER DEFAULT PRIVILEGES` state.

Therefore the remediation candidate deliberately does **not** invent or change
table grants for `application_logs` or `diagnostic_results`.

Before any staging application:

1. a separately authorized production read must capture the sorted
   `information_schema.role_table_grants` fingerprint for the two target
   tables;
2. the separately authorized staging preflight must capture the same
   fingerprint when either table already exists;
3. the expected exact table-grant set must be explicitly established from that
   evidence;
4. if the exact expected grant set cannot be established, the task is
   `BLOCKED` and the migration must not be applied; and
5. if a repository change is required to restore a specific ACL, a new bounded
   repository-remediation authorization is required before database apply.

A database/read gate must not patch or rewrite the migration SQL ad hoc to
resolve ACL uncertainty.

This fail-closed posture is intentional. RLS-policy presence is not a substitute
for table-privilege parity, and this record does not infer privileges from
policy names or application intent.

## Mandatory future staging preflight

`IF NOT EXISTS` and policy-name guards are idempotency mechanisms, not structure
parity checks.

For every target object covered by the fingerprint protocol below:

- **object absent**: it may be treated as a restoration target by the separately
  authorized migration application;
- **object present and every required fingerprint matches**: it may remain in
  place and the idempotent candidate may proceed;
- **object present and any required fingerprint differs, is missing, is
  ambiguous, or cannot be normalized deterministically**:
  `BLOCKED_CONTEXT_NOT_VERIFIED` / stop before migration application.

The operator must not use `IF NOT EXISTS`, duplicate-object handling, or a
matching object/policy name as evidence that an existing object has the correct
shape.

Enum labels are part of this preflight. An existing enum with the right type
name but different labels or label order is a mismatch and must stop.

## Reproducible fingerprint protocol

The following are query **templates only**. They have not been executed by this
repository-candidate remediation. A later database/read gate must bind the
exact database/project identity before running them, preserve the raw sorted
output (or an agreed deterministic hash plus raw evidence), and record whether
the source was staging or production.

### 1. Function definition, owner, and `proacl`

```sql
SELECT
  p.oid::regprocedure::text AS identity,
  pg_get_functiondef(p.oid) AS function_definition,
  md5(pg_get_functiondef(p.oid)) AS functiondef_md5,
  pg_get_userbyid(p.proowner) AS owner,
  COALESCE(p.proacl::text, '<NULL>') AS proacl
FROM pg_proc AS p
WHERE p.oid =
  to_regprocedure('public.claim_daily_checkin(uuid)');
```

A missing row is an absent-object result. A present row must be compared using
all five fields, including the raw `pg_get_functiondef` output and its
deterministic hash, not the function name alone.

### 2. Table columns, types, nullability, and defaults

```sql
SELECT
  table_schema,
  table_name,
  ordinal_position,
  column_name,
  data_type,
  udt_schema,
  udt_name,
  is_nullable,
  COALESCE(column_default, '<NULL>') AS column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('application_logs', 'diagnostic_results')
ORDER BY table_name, ordinal_position;
```

### 3. Enum labels and order

```sql
SELECT
  n.nspname AS enum_schema,
  t.typname AS enum_name,
  e.enumsortorder,
  e.enumlabel
FROM pg_type AS t
JOIN pg_namespace AS n ON n.oid = t.typnamespace
JOIN pg_enum AS e ON e.enumtypid = t.oid
WHERE n.nspname = 'public'
  AND t.typname IN ('diagnostic_status', 'diagnostic_category')
ORDER BY t.typname, e.enumsortorder;
```

### 4. RLS and forced-RLS posture

```sql
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  c.relrowsecurity,
  c.relforcerowsecurity
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relname IN ('application_logs', 'diagnostic_results')
ORDER BY c.relname;
```

### 5. Constraints

```sql
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid, true) AS constraint_definition
FROM pg_constraint AS con
JOIN pg_class AS c ON c.oid = con.conrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('application_logs', 'diagnostic_results')
ORDER BY c.relname, con.conname;
```

### 6. Indexes

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('application_logs', 'diagnostic_results')
ORDER BY tablename, indexname;
```

The future comparison domain is the complete result of this query, including
PRIMARY KEY backing indexes. Each row must retain both `indexname` and
`indexdef`; comparison by index name alone is insufficient.

### 7. Non-internal triggers

```sql
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('application_logs', 'diagnostic_results')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;
```

### 8. Policies: full semantic fields

```sql
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  COALESCE(qual, '<NULL>') AS qual,
  COALESCE(with_check, '<NULL>') AS with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('application_logs', 'diagnostic_results')
ORDER BY tablename, policyname;
```

### 9. Sorted table grants

```sql
SELECT
  table_schema,
  table_name,
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('application_logs', 'diagnostic_results')
ORDER BY table_name, grantee, privilege_type, is_grantable;
```

The raw grant output must be retained. An empty set, an unexpected role, an
unexpected privilege, or a missing required privilege is not silently repaired.

## Comparison and stop semantics

For each environment, preserve the raw sorted results for all applicable
queries above. Comparison must be field-for-field after only deterministic
format normalization. Do not discard extra indexes, grants, policies,
constraints, triggers, enum labels, or ACL entries merely because the expected
named object is present.

Required decisions:

- `ABSENT_RESTORATION_TARGET`: object is absent and candidate may create it,
  subject to the separately authorized database gate.
- `MATCH`: all required fingerprints match the accepted expected posture.
- `MISMATCH_BLOCKED`: at least one required fingerprint differs.
- `UNRESOLVED_BLOCKED`: expected posture cannot be established or evidence is
  incomplete.

Only `ABSENT_RESTORATION_TARGET` or `MATCH` may proceed to a separately
authorized staging application. `MISMATCH_BLOCKED` and `UNRESOLVED_BLOCKED`
must stop.

Production is evidence-only for STG-FIX and must never be rewritten to force a
match.

## Validation status

| Evidence item | Current status |
| --- | --- |
| Repository-derived expected structure | `RECORDED` |
| Complete future fingerprint query template | `RECORDED_NOT_EXECUTED` |
| Exact table-grant expectation | `UNRESOLVED_FAIL_CLOSED — separate production-read evidence required` |
| Staging live structure fingerprint | `NOT_EXECUTED — separate Owner database gate required` |
| Production read-only parity fingerprint | `NOT_EXECUTED — separate Owner production-read gate required` |
| First staging migration application | `NOT_EXECUTED — separate Owner database gate required` |
| Second staging migration application / idempotency | `NOT_EXECUTED — separate Owner database gate required` |
| Database PASS / Evaluator PASS / Release Auditor PASS | `NOT_ASSERTED` |

The candidate intentionally does not recreate `user_checkins`, `profiles`,
`credit_transactions`, or `system_settings`; those are dependencies of the
bounded function and remain outside the exact STG-FIX write allowlist. Any
dependency or live-structure mismatch must be reported rather than repaired by
expanding this candidate's scope.

No database fingerprint, query result, secret, production definition, database
PASS, Evaluator PASS, or Release Auditor PASS is recorded in this repository
candidate.
