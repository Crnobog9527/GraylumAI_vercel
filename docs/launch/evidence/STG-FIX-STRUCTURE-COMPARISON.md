# STG-FIX structure-comparison evidence record

Status: `STABLE_FINAL_STG_FIX_EVIDENCE_IDENTITY_CLOSEOUT_BY_C7`

This record preserves the forward-only C5/C6 evidence reconciliation and applies
only the C7 stable post-merge identity closeout. It does not rerun a database
query or migration. C1-C6 historical evidence, C4 database validation, and C5/C6
audit provenance remain historical facts and are not retroactively reinterpreted.
No raw fingerprint or current Vercel deployment identity is invented.

A live branch ref is inherently time-varying. This repository record therefore
does not persist any SHA as an indefinitely current `staging` ref. Any assertion
about the live current `staging` ref must be fresh-read from GitHub live state.
Persisted branch SHAs below are bounded to explicit historical events or the C7
branch-creation snapshot.

## Stable / final STG-FIX evidence

### Contract and durable lineage

| Field | Stable/final value |
| --- | --- |
| Task Issue | `#322` |
| Historical execution contract | `STG-FIX-ISSUE-322-C4` |
| Historical evidence-reconciliation contract | `STG-FIX-ISSUE-322-C5` |
| Historical identity-reconciliation contract | `STG-FIX-ISSUE-322-C6` |
| Current stable-identity closeout contract | `STG-FIX-ISSUE-322-C7` |
| C4 Owner gate | Issue #322 comment `5327870357` |
| C4 durable final result | Issue #322 comment `5328099005` |
| C5 repository gate | Issue #322 comment `5329885802` |
| C5 canonical Evaluator PASS | PR #335 comment `5333616844` |
| C5 canonical Release Auditor PASS | PR #335 comment `5333620329` |
| C6 Owner gate | Issue #322 comment `5333774702` |
| C6 canonical Evaluator PASS | PR #339 comment `5334007980` |
| C6 canonical Release Auditor PASS | PR #339 comment `5338833049` |
| C7 Owner gate | Issue #322 comment `5339310420` |
| Production durable fingerprint result | Issue #322 comment `5324287732` |
| Historical C2 staging result | Issue #322 comment `5324869886` |
| Main SHA at C7 branch creation | `ecf4c6a347038f9352477a98d4171a8ef00c85de` |
| Historical PR #334 actual merge SHA / C5 pre-merge audited staging base | `5d8b38fd5046a94d6f525c8da72dbca8d0aa6f4d` |
| Historical audited PR #334 head | `175a2f5ae1e23740b1f03196642ccf8f3953e122` |
| PR #335 audited head | `a96ba4c6706c1b4aecd0e332c249d4832712863d` |
| PR #335 actual merge SHA | `ec9925410b513484c69b5c1decb2abda7882646c` |
| PR #339 audited head | `e13b9dd3694a01a618c2bf43262aea1285bfaeec` |
| PR #339 actual merge SHA | `5fe07eb5877a74380061d97bee470d0e6dd40c76` |
| Latest completed STG-FIX staging merge SHA at C7 branch creation | `5fe07eb5877a74380061d97bee470d0e6dd40c76` |
| Staging SHA at C7 branch creation | `5fe07eb5877a74380061d97bee470d0e6dd40c76` |
| Live current staging ref | `FRESH_READ_FROM_GITHUB_REQUIRED` |
| STG-FIX specification blob | `96806c8ce0baac0e85ebb462a17b53f04963de9a` |

### Merged repository identity

```yaml
pr_334:
  merged: true
  base_branch: staging
  historical_base_sha: 0cfe8e09eb90a2238ada5c7d9ed8a564d46d280b
  head_branch: codex/stg-fix-322
  audited_head_sha: 175a2f5ae1e23740b1f03196642ccf8f3953e122
  actual_merge_sha: 5d8b38fd5046a94d6f525c8da72dbca8d0aa6f4d
  identity_semantics: HISTORICAL_PR_334_MERGE_IDENTITY
  merge_contains_audited_head: true

c5_pre_merge_audit_identity:
  audited_staging_base_sha: 5d8b38fd5046a94d6f525c8da72dbca8d0aa6f4d
  pr_335_audited_head_sha: a96ba4c6706c1b4aecd0e332c249d4832712863d
  evaluator_pass_comment: 5333616844
  release_auditor_pass_comment: 5333620329

pr_335:
  merged: true
  base_branch: staging
  head_branch: codex/stg-fix-322-c5-evidence-closeout
  audited_head_sha: a96ba4c6706c1b4aecd0e332c249d4832712863d
  actual_merge_sha: ec9925410b513484c69b5c1decb2abda7882646c
  staging_after_pr_335_merge_sha: ec9925410b513484c69b5c1decb2abda7882646c
  merge_contains_audited_head: true
  identity_semantics: HISTORICAL_PR_335_MERGE_IDENTITY

pr_339:
  merged: true
  base_branch: staging
  head_branch: codex/stg-fix-322-c6-post-merge-identity-reconciliation
  audited_head_sha: e13b9dd3694a01a618c2bf43262aea1285bfaeec
  actual_merge_sha: 5fe07eb5877a74380061d97bee470d0e6dd40c76
  staging_at_c7_branch_creation_sha: 5fe07eb5877a74380061d97bee470d0e6dd40c76
  latest_completed_stg_fix_merge_sha_at_c7_branch_creation: 5fe07eb5877a74380061d97bee470d0e6dd40c76
  evaluator_pass_comment: 5334007980
  release_auditor_pass_comment: 5338833049
  merge_contains_audited_head: true
  identity_semantics: LATEST_COMPLETED_STG_FIX_MERGE_AT_C7_BRANCH_CREATION

live_current_staging_ref: FRESH_READ_FROM_GITHUB_REQUIRED

repository_blobs_at_c7_branch_creation:
  packages/db/migrations/0048_restore_staging_baseline_objects.sql: 96b57ea4c7cd153cc43b40ec65ebdfd151c80ff5
  packages/db/migrations/0049_reconcile_stg_fix_target_grants.sql: 1a05b778b1ca1ad80c0ff7cd5f8e4c6892187988
```

C5, C6, and C7 change neither migration. C7 only removes self-invalidating
static-current-ref semantics and records the completed PR #339 merge identity
with explicit event/snapshot bounds.

### Durable C4 staging execution result

Source: append-only Issue #322 comment `5328099005`,
`STG_FIX_C4_STAGING_EXECUTION_AND_FINAL_VALIDATION_RESULT_V1`.

```yaml
0049_application:
  exact_application_count_under_c4: 1
  result: SUCCESS

second_identical_0048:
  exact_application_count_under_c4: 1
  result: SUCCESS

migration_application_state:
  total_proven_0048_application_count: 2
  total_proven_0049_application_count: 1
  application_state: PASS

final_validation:
  application_logs_grants: 28
  diagnostic_results_grants: 28
  final_grant_parity: MATCH
  final_non_grant_structure_parity: MATCH
  function_definition_and_acl_posture: MATCH
  user_checkins_normalized_shape_preserved: MATCH
  unexpected_destructive_effect: NONE
  unexpected_grant_or_structure_drift: NONE
  decision: PASS

machine_decision: STG_FIX_C4_STAGING_FINAL_VALIDATION_PASS
```

The C4 durable result also records post-0049 grant parity `MATCH`, non-grant
structure parity `MATCH`, no unexpected extra grants, and that the second
identical 0048 application occurred only after the mandatory post-0049
validation passed.

### Object fingerprint provenance

The authoritative STG-FIX Definition of Done requires object fingerprints. C5
does not query a database and does not synthesize raw values. The following
fingerprints are copied from the fresh-read durable production result
`5324287732`; final staging equivalence is bound by the durable C4 comparison
decisions in `5328099005`.

#### Function fingerprint — `public.claim_daily_checkin(uuid)`

Source: production durable result `5324287732`.

```yaml
raw_identity: claim_daily_checkin(uuid)
functiondef_md5: 4dea61c0fe2a838a641b27619e1a7d0e
owner: postgres
proacl: "{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}"
production_comparison_decision: MATCH
final_staging_function_definition_and_acl_posture:
  decision: MATCH
  source: 5328099005
```

The raw production `pg_get_functiondef` string is retained in durable comment
`5324287732`; this repository record intentionally stores its deterministic MD5,
owner and ACL plus exact provenance instead of duplicating the full function
body. No raw final-staging function value is invented here.

#### Table / policy / index / grant fingerprint summary

Source: production durable result `5324287732`.

```yaml
public.application_logs:
  column_rows: 8
  constraint_rows: 4
  index_rows: 10
  non_internal_trigger_rows: 0
  policy_rows: 2
  grant_rows: 28

public.diagnostic_results:
  column_rows: 12
  constraint_rows: 3
  index_rows: 6
  non_internal_trigger_rows: 0
  policy_rows: 2
  grant_rows: 28

enum_rows: 10

production_comparison_decisions:
  FUNCTION_PARITY: MATCH
  TABLE_PARITY: MATCH
  INDEX_PARITY: MATCH
  ENUM_PARITY: MATCH
  RLS_PARITY: MATCH
  CONSTRAINT_PARITY: MATCH
  TRIGGER_PARITY: MATCH
  POLICY_PARITY: MATCH
  GRANT_PARITY: MATCH

final_staging_decisions:
  final_non_grant_structure_parity:
    decision: MATCH
    source: 5328099005
  final_grant_parity:
    decision: MATCH
    source: 5328099005
  application_logs_grant_rows:
    value: 28
    source: 5328099005
  diagnostic_results_grant_rows:
    value: 28
    source: 5328099005
```

Exact enum fingerprint retained by production durable result `5324287732`:

```text
public.diagnostic_category: 1=ai, 2=billing, 3=security, 4=performance, 5=data
public.diagnostic_status: 1=passed, 2=failed, 3=warning, 4=skipped, 5=error
```

The complete raw sorted production table-grant rows and other raw production
fingerprint rows remain in durable comment `5324287732`. The final C4 durable
record supplies the final staging `MATCH` decisions and exact 28/28 grant row
counts. Where C4 does not repeat a raw fingerprint value in this repository
record, the durable comment identity is the provenance; C5 does not fabricate a
replacement raw value.

### HISTORICAL_PRE_C5_MERGE_DEPLOYMENT_OBSERVATION

This deployment record is preserved only as a historical pre-C5-merge
observation. C6/C7 did not access or mutate Vercel, and no authorized fresh
read-only source in this execution proved a replacement current deployment
identity. Therefore this record must not be interpreted as the current Vercel
staging deployment.

```yaml
project_name: graylumai-staging
project_id: prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC
deployment_id: dpl_2hXdyR6UH8nYKqPZ5QYTaan4RXXn
state_at_observation: READY
git_branch_at_observation: staging
git_commit_sha_at_observation: 5d8b38fd5046a94d6f525c8da72dbca8d0aa6f4d
historical_identity: HISTORICAL_PRE_C5_MERGE_STAGING_IDENTITY
binds_current_staging_sha: false
current_vercel_staging_deployment_identity: NOT_ASSERTED_BY_C6_OR_C7
```

### Current non-actions / boundary

```yaml
PRODUCTION_ACCESS: false
PRODUCTION_MUTATION: false
PRODUCTION_DEPLOY: false
PRODUCTION_SMOKE: false
STAGING_TO_MAIN_PROMOTION: false
STG_FIX_ISSUE_CLOSED: false
NEXT_LAUNCH_TASK_STARTED: false
C5_SUPABASE_ACCESS: false
C5_DATABASE_QUERY: false
C5_SQL_EXECUTION: false
C5_VERCEL_MUTATION: false
C6_SUPABASE_ACCESS: false
C6_DATABASE_ACCESS: false
C6_SQL_EXECUTION: false
C6_VERCEL_ACCESS: false
C6_VERCEL_MUTATION: false
C7_SUPABASE_ACCESS: false
C7_DATABASE_ACCESS: false
C7_SQL_EXECUTION: false
C7_VERCEL_ACCESS: false
C7_VERCEL_MUTATION: false
```

This evidence record does not authorize merge, Issue closure, staging-to-main
promotion, production deployment/smoke, or any next Launch task. C5 canonical
Evaluator and Release Auditor PASS remain historical audit provenance bound to
PR #335 audited head `a96ba4c6706c1b4aecd0e332c249d4832712863d` and pre-merge
staging base `5d8b38fd5046a94d6f525c8da72dbca8d0aa6f4d`. C6 canonical
Evaluator and Release Auditor PASS remain historical audit provenance bound to
PR #339 audited head `e13b9dd3694a01a618c2bf43262aea1285bfaeec` and its audited
pre-merge staging base. None of those reports is reinterpreted as auditing a
later merge commit or a permanently current branch ref.

## HISTORICAL_PRE_C4_STATE

`SUPERSEDED_BY_C4_DURABLE_RESULT_5328099005`

Everything in this section records the pre-C4 C1/C2/C3 repository-candidate
state and remains historical evidence. Statements such as “0049 has not been
remotely applied”, “second staging migration application NOT_EXECUTED”, “final
staging parity has not been established”, and “Database/Evaluator/Release
Auditor PASS NOT_ASSERTED” were true at that historical point. They are not the
current/final STG-FIX state after durable C4 result `5328099005`.

### Historical C3 binding and status

```yaml
historical_status: REPOSITORY_CANDIDATE_C3_GRANT_REMEDIATION
historical_contract: STG-FIX-ISSUE-322-C3
owner_preparation_gate: 5308738373
remediation_v2_gate: 5312811024
c2_repository_remediation_gate: 5317179895
c3_grant_remediation_gate: 5325304686
audited_staging_base: 0cfe8e09eb90a2238ada5c7d9ed8a564d46d280b
main_ref_at_materialization: ecf4c6a347038f9352477a98d4171a8ef00c85de
candidate_0048_blob: 96b57ea4c7cd153cc43b40ec65ebdfd151c80ff5
candidate_0049_blob: 1a05b778b1ca1ad80c0ff7cd5f8e4c6892187988
C3_REMOTE_DATABASE_APPLICATION: NOT_EXECUTED
C3_SUPABASE_ACCESS: NOT_EXECUTED
```

These C3 non-action statements are preserved exactly as historical state and
are `SUPERSEDED_BY_C4_DURABLE_RESULT_5328099005` for current/final validation.

### Historical C2 production/staging evidence

Production durable result `5324287732` established a 28-row table-grant
baseline for each of `public.application_logs` and
`public.diagnostic_results`, with repository-vs-production function, table,
index, enum, RLS, constraint, trigger, policy and grant decisions `MATCH`.
Production row-data read and production mutation were false.

Historical staging result `5324869886` recorded the first exact 0048 staging
application as successful, C2 dependency normalization as `MATCH`, complete
structural fingerprint excluding grants as `MATCH`, and the only first
postflight failing domain as table grants. At that point each target table had
16 grant rows versus the 28-row production baseline. The missing rows were
`SELECT`, `INSERT`, `UPDATE`, and `DELETE` for each of `anon`, `authenticated`,
and `service_role`; no unexpected extra staging grants requiring removal were
durably proven. The second identical 0048 application was not executed at that
C2 fail-closed point.

### Historical C3 repository-only grant remediation

Migration 0048 remained byte-identical and immutable. Migration 0049 added only
six deterministic, idempotent `GRANT` statements: one per grantee for each of
`public.application_logs` and `public.diagnostic_results`, granting only
`SELECT`, `INSERT`, `UPDATE`, and `DELETE` to `anon`, `authenticated`, and
`service_role`. It contained no `REVOKE`, `ALTER DEFAULT PRIVILEGES`, unrelated
grant, or structural statement.

At the C3 repository-only stage:

- `C3_REMOTE_DATABASE_APPLICATION: NOT_EXECUTED`
- `C3_SUPABASE_ACCESS: NOT_EXECUTED`
- migration 0049 had not been remotely applied;
- final staging parity had not been established;
- the second staging migration application remained `NOT_EXECUTED`; and
- Database PASS / Evaluator PASS / Release Auditor PASS were `NOT_ASSERTED`.

All six statements above are `HISTORICAL_PRE_C4_STATE` and
`SUPERSEDED_BY_C4_DURABLE_RESULT_5328099005` for current/final state.

### Historical local disposable-database validation

C2 local disposable PostgreSQL validation passed:

- reproduced the known `user_checkins.checkin_date` TEXT drift shape, with no
  streak-day check, the bound primary-key index name, and the observed single
  policy;
- the first identical 0048 execution succeeded;
- post-normalization `checkin_date` was `date`, the streak check existed, three
  0013 policies existed, and helper search path was `public, pg_temp`;
- a sentinel row inserted after normalization survived the second identical
  0048 execution with count `1`;
- no Supabase, staging, production, or remote database access occurred in that
  local validation.

C3 local disposable PostgreSQL validation passed:

- reproduced the durable post-0048-equivalent 16-row grant state per target
  table;
- first local 0049 application produced 28 grant rows per target table;
- second identical local 0049 application remained 28 rows per table;
- complete deterministic non-grant structural fingerprint remained
  `59|79e465dd0718f76552e4f6f3ea4d6e9b` before, after first apply, and after
  second apply;
- this fingerprint is explicitly a local disposable-database fingerprint, not
  a fabricated final staging fingerprint;
- no Supabase, staging, production, or remote database access occurred.

### Historical repository-derived expected structure

`public.claim_daily_checkin(uuid)` was derived from migration 0027 and expected
to remain `SECURITY DEFINER`, `LANGUAGE plpgsql`, with
`SET search_path = public, pg_temp`, the recorded return shape, authenticated
caller/user match protection, and function ACL posture that revokes PUBLIC,
`anon`, and `authenticated` before granting `EXECUTE` to `authenticated` and
`service_role`.

`public.application_logs` repository expectation included the table shape from
0006, later indexes from 0007, 0015 policy hardening, RLS enabled, policies
`Admin can view all logs` and `Users can view own logs`, and the complete ten
index identities:

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

`public.diagnostic_results` repository expectation included the table/enums and
indexes from 0005, 0015 policy hardening, RLS enabled, policies
`Admins can view all diagnostic results` and
`Admins can insert diagnostic results`, and the complete six index identities:

- `diagnostic_results_pkey`
- `idx_diagnostic_results_batch_id`
- `idx_diagnostic_results_test_id`
- `idx_diagnostic_results_category`
- `idx_diagnostic_results_status`
- `idx_diagnostic_results_created_at`

The similarly named `diagnostics_results` block in migration 0007 referred to a
different table identity and did not change the expected `diagnostic_results`
index set. Primary-key backing indexes were always part of the comparison
domain; extra rows were never to be discarded merely to force a match.

### Historical pre-C3 ACL uncertainty and fail-closed rule

Before the durable production/staging results, repository migrations did not
deterministically encode the complete hosted table ACL/default-privilege state
for the two target tables. The pre-C3 candidate therefore did not invent table
grants. The historical procedure required a separately authorized production
read and staging preflight, complete sorted
`information_schema.role_table_grants` fingerprints, and fail-closed behavior
if the exact expected grant set could not be established. Ad-hoc SQL remediation
was not authorized.

The production result `5324287732` and historical staging result `5324869886`
resolved that uncertainty for the later 0049 repository remediation. The old
sentence “migration 0049 has not been remotely applied, and final staging parity
has not been established” is preserved here only as
`HISTORICAL_PRE_C4_STATE`; it is superseded by C4 result `5328099005`.

### Historical fingerprint protocol

The pre-C4 evidence protocol required deterministic capture and comparison of:

1. `public.claim_daily_checkin(uuid)` identity, raw `pg_get_functiondef`, MD5,
   owner, and `proacl`;
2. target-table columns/types/nullability/defaults;
3. diagnostic enum labels and order;
4. RLS and forced-RLS flags;
5. constraints and `pg_get_constraintdef`;
6. complete `pg_indexes` rows including both `indexname` and `indexdef`;
7. non-internal triggers and definitions;
8. full policy semantics (`policyname`, permissive mode, roles, command, `qual`,
   `with_check`); and
9. complete sorted `information_schema.role_table_grants` rows.

Comparison was field-for-field after deterministic normalization. Extra
indexes, grants, policies, constraints, triggers, enum labels, or ACL entries
could not be discarded. Production remained evidence-only and could never be
rewritten to force parity.

### Historical pre-C4 validation-status snapshot

The pre-C4 snapshot is retained without being treated as current state:

| Evidence item | Historical pre-C4 status |
| --- | --- |
| Repository-derived expected structure | `RECORDED` |
| Fingerprint query protocol | `RECORDED` |
| Production read-only parity fingerprint | `RECORDED_IN_DURABLE_RESULT_5324287732` |
| First 0048 staging application | `RECORDED_IN_DURABLE_RESULT_5324869886 — SUCCESS` |
| First post-0048 non-grant structure parity | `MATCH` |
| First post-0048 grant parity | `MISMATCH — 16 vs 28 rows per target table` |
| C3 local disposable-DB 0049 double-run | `PASS` |
| C3 local non-grant fingerprint | `59|79e465dd0718f76552e4f6f3ea4d6e9b — LOCAL ONLY` |
| Remote 0049 application | `NOT_EXECUTED` |
| Second identical 0048 staging application | `NOT_EXECUTED` |
| Final staging parity | `NOT_ESTABLISHED` |
| Database PASS / Evaluator PASS / Release Auditor PASS | `NOT_ASSERTED` |

`SUPERSEDED_BY_C4_DURABLE_RESULT_5328099005`

## C7 stable post-merge identity closeout validation posture

The stable/final section above preserves C4 final validation and C5/C6 durable
audit provenance while recording PR #334, PR #335, and PR #339 only with
historical or event-bounded identity semantics. The live current `staging` ref is
not represented by a persisted static SHA and must be fresh-read from GitHub live
state whenever current identity matters. C7 performs no database validation, no
Supabase access, no production access, and no Vercel access or mutation.
Migration 0048 and 0049 remain byte-identical. The exact one-file repository
diff and exact-head CI/Security status are validated at the C7 Draft PR boundary;
no merge, Issue closure, promotion, production action, next gate, or next Launch
task is implied by this record.