# Diagnosis and proposed minimal repair (before implementation)

Baseline: staging ecf73b428e1f6018996b5ab5424b3389fdaf752b, 160/160 file-build steps.
Disposable PostgreSQL 17; synthetic positioning-draft sessions, five history rows per execution,
up to 200 direct ancestor edges per execution (1,000 retained items). No remote database/model calls.
These local synthetic numbers are not a reproduction of the exact staging OPC data or host capacity.

| Executions | history | view ms | session items ms | admit ms | last history check ms |
|---|---:|---:|---:|---:|---:|
| 15 | 75 | 569.668 | 310.106 | 685.249 | 13.546 |
| 50 | 250 | 6595.398 | 6947.403 | 5610.399 | 48.013 |
| 100 | 500 | 23746.297 | 15313.523 | 15397.036 | 59.329 |
| 300 | 1500 | 267086.014 | 167235.997 | 188713.686 | 234.022 |

Full EXPLAIN ANALYZE/BUFFERS plans are recorded in before.json. All four sizes completed on
the unchanged baseline. This document preserves the initial proposal; the final scope is below.

## Findings

1. runtime_view calls runtime_history_available up to seven times per execution. The read/freeze/admit
   history paths call it per history row rather than per distinct execution.
2. Each history check recursively rechecks all ancestor permissions. At 100 executions one check visits
   99 ancestors and calls the direct billing permission function 100 times. Scope wrappers amplify this.
3. Three SQL-language bill2_scope_allowed layers retain SET search_path and cannot inline. Nested plans
   and a same-expression prepared-query comparison show repeated planning cost. Reuse the exact predicates
   with PL/pgSQL's cached statement plans rather than introducing another permission authority.
4. runtime_history_available repeats runtime_context_allowed after runtime_billing_allowed has already
   checked the same execution payload. The latter also checks every ancestor payload. Remove only this
   proven redundant outer check; retain all lineage, actor, model, scope, package and source checks.
5. Empty EXCEPTION guard overhead: 10,000 iterations plain 6.899 ms, guarded 9.768 ms (~0.000287 ms extra
   per call). Keep the guard and its exact caught SQLSTATE classes; transaction/storage errors propagate.
6. The 300-execution recursive query takes 67.043 ms including 16.540 ms JIT generation. Evaluate narrowly
   scoped JIT suppression only if needed; do not change server configuration. Existing primary/unique
   indexes cover execution id, billing run id and dependency execution id. No demonstrated missing index
   justifies speculative additions in this slice.

## Implementation proposal

- Migration 0158: materialized per-execution availability CTEs in view and bounded historical selection
  (admit, session read/freeze). Preserve existing ordering, limits, fields and locking. A MATERIALIZED
  boundary prevents optimizer flattening from reintroducing repeated calls.
- Remove the duplicate outer context check only. Keep runtime_billing_allowed semantics and its
  permission locks. Keep exception-to-false behavior for permission denial.
- Convert the three existing scope SQL wrappers to PL/pgSQL RETURN of the same scalar SELECT, preserving
  STABLE, search_path, signatures, security mode, ACLs and every predicate. No persistent cache,
  new table, new RPC family, permission shortcut or cross-request result cache.
- Pin original and built MD5 per changed function; transactional all-or-nothing drift guard, repeatability,
  explicit rollback to the original definitions. Update the canonical built fingerprint only for changes.
- Compare old/new JSON text byte-for-byte on identical data; benchmark all four sizes, assert under
  1,000 ms for view/items up to 100, and test active/denied/deleted/revoked/dependency/error paths.
  Run repository baseline/runtime/billing validation and required remote checks. Controller arranges review.

## Pagination assessment (proposal only)

Do not change history membership or silently read only recent N turns in this repair: that changes output,
answer-card/recovery behavior and selected model context. The current model history already has its own
bounded selection; UI projection is separate. For very large bodies (up to 256 KiB per execution), a later
Claude frontend slice should add a backward cursor keyed by (created_at,id), load recent executions first,
retain active/pending recovery and latest-card identity, and offer explicit older-history loading. Define a
new paged response contract rather than truncating runtime_view in place. No frontend changes here.

Risk high. Merge and remote application still require separate Owner approvals. This is a proposed
implementation, not passing performance/equivalence evidence or a clean candidate.

## Final implementation after the first experiment

The first per-root CTE / scope-plan experiment failed the target: at 100 executions, view 2812 ms and
items 2955 ms. Disabling JIT in a local transaction still left view at 1980 ms. Therefore the final
migration does **not** modify scope permission functions, JIT configuration or indexes.

One private `runtime_history_availability(uuid[])` helper collects the union of ancestors for the
requested roots, invokes existing direct/context permission checks once per unique execution, then
propagates denials back over the existing dependency graph. It has no persistent state or client/service
execute grant. It preserves cross-actor rejection, unavailable flags, missing-run join behavior, cyclic
graph termination, permission locks and the original caught error classes. Equal frozen execution and
billing-input context is checked once; distinct payloads still get independent checks.

The four existing functions change only to consume this statement-local batch result (view, admission,
read/freeze) and remove the scalar helper's redundant context call. Session read retains its separate
current-execution authorization, including all ancestors, before selecting history. Thus a 100-execution
view performs 100 direct checks; a 100-execution read performs 199 (100 for current authorization plus
99 for selected history), rather than repeatedly traversing ancestors for each of 495 history rows.

Pagination remains a later frontend proposal. No output is truncated and no frozen model history is
changed. Local performance evidence is not staging acceptance; the reported staging timeout needs a
fresh browser check after the separately approved application.
