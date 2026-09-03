# Launch Plan Core

This document is the Launch product structure and discovery root. It stores no
runtime authorization, current-task writer state, or automatic-progression state.

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

Resolve completion from live evidence and compute:

`ready(task) = NOT completed(task) AND every dependency is completed`

Candidates may be presented in deterministic `priority`, `order`, then `task_id`
order. This ordering is informational only.

A ready candidate is never an authorized task, even when exactly one candidate
is ready.

## Launch selection boundary

- Only the Owner may select the next named Launch task.
- The selected task must be a member of the currently derived ready-candidate set.
- Readiness narrows eligible Owner choices but never selects or authorizes a task.
- If the selected task is not ready, return `NO_PRODUCT_TASK_AUTHORIZED` with
  reason `OWNER_SELECTED_TASK_NOT_READY`.
- If no task is explicitly selected, return `NO_PRODUCT_TASK_AUTHORIZED`.
- No Agent may infer task authorization from dependency completion, priority,
  ordering, a previous task finishing, a historical Gate, or tracker prose.
- After an eligible Owner selection, current `AGENTS.md` governs risk,
  implementation mechanics, validation, review, merge, and external boundaries.
- Product specifications remain product/technical inputs, not execution authority.
- Multiple or conflicting current task identities, completion evidence, or
  overlapping writers produce `BLOCKED_CONTEXT_NOT_VERIFIED`.
- After any selected task completes, stop. Never automatically progress to
  another node.

## Writer and recovery invariants

Exactly-one-writer is required for overlapping implementation work.

Retired trackers, historical Issues, old Harness material, Gates, receipts, and
completion prose are evidence/history only. They cannot become a second writer or
fallback authority.

Base/head drift, failed checks, writer conflict, or failed transition must be
resolved from fresh GitHub live state under current `AGENTS.md`. Never restore a
retired governance writer as fallback.
