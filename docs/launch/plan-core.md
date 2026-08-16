# Launch Plan Core

`STAGING_REF_CONDITIONAL_ACTIVE`

This document is the Launch Plan structural and task-discovery root only when this exact cutover content is present on the authoritative current `staging` ref under the repository-wide `AGENTS.md` + accepted `DEVELOPMENT_POLICY.md` / G2 authority chain. A feature branch, commit, Draft PR, review, check, Issue, or gate does not activate this file.

When that authoritative-staging condition is true, `docs/launch/START_HERE.md` + this `plan-core.md` are the sole Launch product-task discovery/selection root. This file contains plan structure only; it stores no progress, runtime, completion, authorization, or current-task state.

## Task structure

| task_id | depends_on | lane | migration_slot | priority | order |
| --- | --- | --- | --- | ---: | ---: |
| `R0-A` | — | `shared` | `none` | 10 | 10 |
| `GOV-1` | `R0-A` | `shared` | `none` | 20 | 20 |
| `R0-B` | `GOV-1` | `shared` | `none` | 30 | 30 |
| `STG-FIX` | `R0-B` | `money` | `SLOT-1` | 40 | 40 |
| `SEC-1` | `STG-FIX` | `money` | `SLOT-2` | 50 | 50 |
| `AUTH-1` | `SEC-1` | `money` | `SLOT-3` | 60 | 60 |
| `YEAR-1` | `AUTH-1` | `money` | `SLOT-4` | 70 | 70 |
| `REFUND-1B` | `YEAR-1` | `money` | `SLOT-5` | 80 | 80 |
| `BILL-1` | `REFUND-1B` | `money` | `none` | 90 | 90 |
| `SKILL-1A` | `STG-FIX` | `product` | `SLOT-6` | 100 | 100 |
| `SKILL-1B` | `SKILL-1A` | `product` | `none` | 110 | 110 |
| `PAY-1` | `STG-FIX` | `product` | `none` | 120 | 120 |
| `CI-1` | `STG-FIX` | `product` | `none` | 130 | 130 |
| `REL-1` | `BILL-1`, `SKILL-1B`, `PAY-1`, `CI-1` | `shared` | `none` | 140 | 140 |

## Ready-candidate derivation rule

The read-only derivation evaluates each node using live completion evidence external to this file. A task is ready only when:

`ready(task) = NOT completed(task) AND every dependency is completed`

The derivation then emits eligible node IDs ordered by ascending `priority`, ascending `order`, and finally `task_id` as a deterministic tie-breaker. `plan-core` stores no progress, runtime, or completion state; `completed(task)` is resolved from external evidence at derivation time.

The derivation output is a projection called a ready-candidate set. A ready candidate is not an authorized task.

## Launch-lane authority boundary

- Repository-wide authorization remains governed by the authoritative `AGENTS.md`. Ordinary repository work does not universally require a dedicated Task Issue or a separately posted receipt.
- Launch product-task selection intentionally uses a narrower durable convention. A ready Launch candidate becomes executable only when there is a real dedicated Task Issue, an exact task-specification/materialized canonical-contract binding, and an exact current Owner authorization/gate for that task.
- Delegated Control-Plane Bookkeeping remains available exactly as `AGENTS.md` permits, so an Agent may record the Owner-approved dedicated Task Issue and bounded gate without requiring the Owner to manually create or copy them.
- The exact current gate must bind the live repository identity, fresh refs, the exact task-specification/materialized-contract identity, and the permitted action scope before Generator work begins.
- Priority and order determine only deterministic presentation order; they do not grant authorization and do not permit autonomous task choice.
- Zero valid executable Launch candidates produces `NO_PRODUCT_TASK_AUTHORIZED`.
- Multiple or conflicting valid executable Launch candidates produces `BLOCKED_CONTEXT_NOT_VERIFIED`.
- No Agent may choose among multiple candidates, infer authorization from readiness or priority, or automatically progress to another task.
- This Launch convention narrows task selection only. It does not expand repository permissions, authorize merge or production, or override any Permanent Forbidden Action in `AGENTS.md`.

## Exactly-one-writer and recovery

When the authoritative-staging condition is true, retained legacy tracker/runtime/recovery material is evidence, history, index, or backlog data only for Launch task-selection purposes and cannot become a second writer or fallback selector. `dual_write_allowed=false`; legacy fallback is forbidden.

Before the later cutover merge, this file remains inactive and the existing authoritative staging state is unchanged. Base/head/CAS drift, failed checks, failed audit, or a failed merge means no activation and no reinterpretation or restoration of legacy authority.

After a successful cutover merge, later cleanup failure cannot reactivate a legacy selector. If Launch authority later needs correction, fail closed to `NO_PRODUCT_TASK_AUTHORIZED` (or `BLOCKED_CONTEXT_NOT_VERIFIED` when identities conflict) and require a new exact forward governance change. Recovery is forward-only; automatic legacy restoration is forbidden.
