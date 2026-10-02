# RUNTIME-VIEW-PERF

Risk **high**: four existing database functions plus one private, stateless helper in migration 0158.
No frontend, schema tables, dependency changes, model calls or remote database access. Merge and remote
migration application require separate Owner approval. Independent review is reserved for the controller.

Diagnosis and proposal were published before implementation:
- [Initial diagnosis](https://github.com/Crnobog9527/GraylumAI_vercel/pull/586#issuecomment-5950218830)
- [Measured failure of the first approach and narrowed final proposal](https://github.com/Crnobog9527/GraylumAI_vercel/pull/586#issuecomment-5950306386)

## Result

`runtime_view` and historical selections share availability checks across executions and their common
ancestors within one statement. Existing direct/context validators, permission locks, actor boundaries,
revocation behavior and error classes remain authoritative. No permission result persists across requests.

All four view outputs are byte-identical before/after on the same synthetic data. The fixture has five
history rows per execution and up to 200 direct ancestors per execution, with overlapping lineage.

| executions | old view ms | new view ms | old items ms | new items ms | old admit ms | new admit ms |
|---:|---:|---:|---:|---:|---:|---:|
| 15 | 569.668 | 19.147 | 310.106 | 47.38 | 685.249 | 45.977 |
| 50 | 6595.398 | 48.722 | 6947.403 | 72.533 | 5610.399 | 45.267 |
| 100 | 23746.297 | 81.613 | 15313.523 | 106.137 | 15397.036 | 81.314 |
| 300 | 267086.014 | 255.19 | 167235.997 | 465.396 | 188713.686 | 319.596 |

Old timing is one EXPLAIN ANALYZE per operation; new columns are the median of three. Full raw plans and
all timing samples are in before.json/result.json. At 100 executions, maximum view/items times are
92.357/113.814 ms; every measured view/items sample at 15/50/100 is below 1,000 ms. The 15-execution items
series includes a 457.443 ms outlier, retained in the evidence. At 300, maximum view/items are
261.415/593.071 ms. These are local PostgreSQL results, not staging or real-provider latency claims.
The byte-comparison pass seeds all sizes before querying; its separate old-view wall times include that
larger database/planner state and are also recorded rather than mixed into the EXPLAIN table.

## Validation and limits

- PASS: canonical build 161/161, 92 migrations replayed in place, unchanged on repeat; built fingerprint
  changes only four existing functions plus the new helper and its private ACL.
- PASS: all five MD5 drift guards reject atomically; readonly precheck; repeat application; guarded repeat
  rollback with populated data; exact projection and execution/history/run/ledger counts preserved.
- PASS: disabled/deleted actors, revoked draft/material/model, unavailable or foreign ancestor, missing
  execution/run, shared diamond/cycle lineage, freeze valid/repeat/duplicate/outside/revoked selections,
  SQL NULL/malformed scope outcomes and serialization/storage error propagation.
- PASS: dual-connection check retains permission SHARE locks; next statement sees committed revocation.
- PASS: original Runtime suite 152 passed / 5 predefined browser-dependent skips; with the new regression,
  153 passed / 5 predefined skips. No skip list or workflow changed. CI runs the same registered test.
- PASS: API typecheck, new test lint, code-size/diff checks, 23 ledger/bridge contracts, exact-baseline ledger.
- PENDING: exact-head remote CI/Security and controller-arranged independent semantic review.
- NOT_RUN: staging database access/application, staging browser reacceptance, real model calls, merge.

The isolated Runtime suite provides local SDK/PostgREST/database execution evidence. It does not prove
staging step 7; repeat that browser acceptance only after separately approved migration application.
Maximum-sized 256 KiB bodies and network/UI rendering are not represented by the timing fixture.

## Pagination and recovery

No silent recent-N truncation. Existing bounded model history is unchanged. A later Claude frontend
slice can add backward (created_at,id) cursors, explicit older-history loading, and pinned active/latest
answer-card identity via a new response contract. See diagnosis.md for rationale.

Recovery/precheck commands and authority boundaries are in
`packages/db/tests/runtime-view-perf/README.md`. Rollback restores four original definitions, removes only
the private helper and leaves all durable rows intact; later definition/dependency drift fails closed.

## Handoff

Done: local diagnosis, implementation, before/after evidence, regression and permission/recovery tests.
Next: inspect exact-head remote checks, then mark 可以审查 for controller review.
Open blockers: remote checks and independent review pending; no merge or application authorization.
Baseline at branch creation: ecf73b428e1f6018996b5ab5424b3389fdaf752b. Before push, staging advanced to
 e49dc92f8e0ad6d4b1bb296ba83ad203f9e52e75 via unrelated OPC prompt work; policy, database, workflow and
migration 0158 availability are unchanged. #581 modifies separate pricing cases in runtime.integration.ts;
the new performance registration uses a disjoint insertion point to avoid its appended test region.
