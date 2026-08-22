# Launch Plan Core

`STAGING_REF_CONDITIONAL_ACTIVE`

This document is the Launch structural/discovery root only when present on the authoritative current `staging` ref under live `AGENTS.md` plus the accepted `DEVELOPMENT_POLICY.md` / G2 authority chain. It stores no runtime, completion, authorization, current-task, or automatic-progression state.

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

## Ready-candidate derivation

Resolve completion from live external evidence and compute:

`ready(task) = NOT completed(task) AND every dependency is completed`

Candidates may be presented in deterministic `priority`, `order`, then `task_id` order. This ordering is informational only.

A ready candidate is never an authorized task, even when exactly one candidate is ready.

## Launch selection boundary

- Only the Owner may select the next named Launch task, and the selected task must be a member of the currently derived ready-candidate set.
- Readiness narrows the set of eligible Owner choices but never selects or authorizes a task by itself.
- If the Owner selects a task that is not currently ready, return `NO_PRODUCT_TASK_AUTHORIZED` with reason `OWNER_SELECTED_TASK_NOT_READY`; do not classify, plan, or implement it.
- No Agent may infer task authorization from readiness, dependency completion, priority, ordering, a previous task finishing, or a prior gate.
- If the Owner has not explicitly selected a current Launch task, return `NO_PRODUCT_TASK_AUTHORIZED`.
- After an eligible Owner selection, classify the task under current `AGENTS.md`.
- Ordinary Launch work may use the ordinary direct-authorization path and bounded module/risk envelope; a Dedicated Task Issue/canonical report lifecycle is not required by default.
- High-risk Launch work requires the durable task record, canonical contract, adversarial Evaluator, deterministic Release Auditor/Release Gate, staging validation, and explicit Owner transition gate defined by `AGENTS.md`.
- Delegated Control-Plane Bookkeeping may record high-risk task/gate evidence but cannot select the task.
- Multiple/conflicting current task identities, readiness evidence, gates, or writers produce `BLOCKED_CONTEXT_NOT_VERIFIED`.
- After any task or transition completes, stop. Never automatically progress to another node.

## Writer and recovery invariants

Exactly-one-writer is required for the current authorized task. `dual_write_allowed=false`.

Retained trackers, Issues, Harness material, historical gates, and completion prose are evidence/history only and cannot become a second writer or fallback selector.

Base/head drift, failed checks, failed audit, writer conflict, or failed transition fails closed. Recovery is forward-only through fresh live authority and a new exact Owner decision when needed; automatic legacy restoration is forbidden.