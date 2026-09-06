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
| `V3.1-LOAD` | `SKILL-1B` | `product` | `none` | 140 | 140 |
| `V3-PACKAGE-RESEARCH` | `V3.1-LOAD` | `product` | `unassigned` | 150 | 150 |
| `V3-ARTIFACTS` | `V3-PACKAGE-RESEARCH` | `product` | `unassigned` | 160 | 160 |
| `V3-WORKBENCH` | `V3-ARTIFACTS`, `BILL-1`, `PAY-1` | `product` | `none` | 170 | 170 |
| `V3-M3` | `V3-WORKBENCH`, `CI-1` | `shared` | `none` | 180 | 180 |
| `REL-1` | `BILL-1`, `SKILL-1B`, `PAY-1`, `CI-1`, `V3-M3` | `shared` | `none` | 190 | 190 |

## Approved V3 delivery requirements

[V3 specification](tasks/V3-standard-skills.md) defines these product slices. Only
`V3.1-LOAD` (规格同步与标准 Skill 最小真实加载) is selected in this implementation
window. Later rows express delivery dependencies, not permission or automatic task
selection. `unassigned` does not reserve a migration number or authorize SQL.

Preserve SKILL-1A/1B, BILL-1, PAY-1 and CI-1 as historical baseline deliveries;
their merges do not complete V3. Code merges alone do not prove non-production
runtime, private package permissions, provider behavior, billing or M3 acceptance.
`V3-M3` requires the **entire** Master Plan §7 exit, including existing payment/auth/
refund/yearly/cron acceptance and the new V3 cases. It cannot be satisfied by the
first loader PR. Owner selection and separate external/production authorization
remain necessary after every slice and after M3.

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
