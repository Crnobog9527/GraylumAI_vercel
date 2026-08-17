# STG-FIX structure-comparison evidence record

Status: `REPOSITORY_CANDIDATE_TEMPLATE_ONLY`

This file records the repository-derived expected structure for the STG-FIX
candidate. It is not a staging or production readout. No database connection,
Supabase query, structure fingerprint, migration application, or production
read occurred while creating this record.

## Binding

| Field | Value |
| --- | --- |
| Task Issue | #322 |
| Contract | `STG-FIX-ISSUE-322-C1` |
| Owner gate | Issue #322 comment `5308738373` |
| Audited staging base | `0cfe8e09eb90a2238ada5c7d9ed8a564d46d280b` |
| Main ref at bootstrap | `ecf4c6a347038f9352477a98d4171a8ef00c85de` |
| STG-FIX specification blob | `96806c8ce0baac0e85ebb462a17b53f04963de9a` |
| Candidate migration | `packages/db/migrations/0048_restore_staging_baseline_objects.sql` |

## Repository-derived expected structure

The following expectations are derived only from the current staging repository
files. They are not claims about either live database.

### `public.claim_daily_checkin(uuid)`

- Function definition source: `packages/db/migrations/0027_balance_write_surface_lockdown.sql`.
- `SECURITY DEFINER`, `LANGUAGE plpgsql`, and `SET search_path = public, pg_temp`.
- Return columns: `already_claimed`, `checkin_date`, `streak_day`,
  `reward_credits`, `monthly_bonus_credits`, `total_reward_credits`, and
  `monthly_checkin_count`.
- Direct authenticated calls must match `auth.uid()` and `p_user_id`.
- Expected execute grants are `authenticated` and `service_role`; `PUBLIC`,
  `anon`, and `authenticated` are revoked before the explicit grants.

### `public.application_logs`

- Columns and checks are derived from `0006_application_logs.sql`: UUID primary
  key, level/category checks, message, JSONB context, nullable profile foreign
  key with `ON DELETE SET NULL`, request ID, and non-null timestamp.
- Expected indexes are the seven `idx_application_logs_*` indexes defined in
  `0006_application_logs.sql`.
- RLS is enabled.
- Expected repository-defined policies are `Admin can view all logs` and
  `Users can view own logs`.
- The broad `Service can insert logs` policy is intentionally not restored;
  `0015_security_advisor_hardening.sql` removes it and service-role access is
  handled outside that policy.

### `public.diagnostic_results`

- Expected enum values are derived from `0005_diagnostics.sql`:
  `diagnostic_status` is `passed|failed|warning|skipped|error`, and
  `diagnostic_category` is `ai|billing|security|performance|data`.
- Columns and checks are derived from `0005_diagnostics.sql`: UUID primary key,
  test ID/name, the two enums, message, JSONB details, latency, nullable profile
  foreign key, `manual|cron|ci` run type, batch ID, and non-null timestamp.
- Expected indexes are the five `idx_diagnostic_results_*` indexes defined in
  `0005_diagnostics.sql`.
- RLS is enabled.
- Expected repository-defined policies are `Admins can view all diagnostic
  results` and `Admins can insert diagnostic results`.
- The broad `Service can insert diagnostic results` policy is intentionally not
  restored; `0015_security_advisor_hardening.sql` removes it.

## Validation status

| Evidence item | Current status |
| --- | --- |
| Repository-derived expected structure | Recorded above |
| Staging live structure fingerprint | `NOT_EXECUTED — separate Owner database gate required` |
| Production read-only parity fingerprint | `NOT_EXECUTED — separate Owner production-read gate required` |
| First staging migration application | `NOT_EXECUTED — separate Owner database gate required` |
| Second staging migration application / idempotency | `NOT_EXECUTED — separate Owner database gate required` |
| Database PASS / Evaluator PASS / Release Auditor PASS | `NOT_ASSERTED` |

The candidate intentionally does not recreate `user_checkins`, `profiles`,
`credit_transactions`, or `system_settings`; those are dependencies of the
bounded function and remain outside the exact STG-FIX write allowlist. Any
dependency or live-structure mismatch must be reported by the later authorized
validation rather than repaired by changing this candidate's scope.

No database fingerprint, query result, secret, production definition, or PASS
is recorded in this repository candidate.
