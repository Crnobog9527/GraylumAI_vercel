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

Follow the [Launch discovery protocol](START_HERE.md#discovery-protocol).
Read-only discovery, comparison, and readiness audits need no task selection.
Only the Owner selects a new named Launch task from the current ready-candidate
set; continuing that same task needs no reselection. Readiness and task ordering
never grant authorization. After completion, do not automatically start another
node. Current `AGENTS.md` governs implementation and protected effects.

## Writer and recovery invariants

Exactly-one-writer is required for overlapping implementation work.

Retired trackers, historical Issues, old Harness material, Gates, receipts, and
completion prose are evidence/history only. They cannot become a second writer or
fallback authority.

Base/head drift, failed checks, writer conflict, or failed transition must be
resolved from fresh GitHub live state under current `AGENTS.md`. Never restore a
retired governance writer as fallback.
