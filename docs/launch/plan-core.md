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

### 2026-09-07 product amendment: configurable workbench

Owner-approved [generic Skill and configurable workbench requirements](tasks/V3-standard-skills.md#generic-skill-workbench) supplement the historical V3.1-LOAD scope above. This records specification requirements only: no task is selected, started or completed by this amendment. Existing task IDs, dependencies, order and migration slots remain unchanged.

- `V3-ARTIFACTS`: shared project/round/step results, evidence, snapshots, declared-dependency review, fixed workflow/template versions and deterministic report transactions; server isolation across users/projects/Skills/rounds/versions and durable recovery.
- `V3-WORKBENCH`: one core for configured three-, six- and eight-step workflows, retaining the original social six-step template; shared AI/cost mechanisms, configuration-only onboarding of a further sample after the core is complete, and compatibility with non-workflow document Skills.
- `V3-M3`: verify every [generic acceptance case](tasks/V3-standard-skills.md#generic-workbench-acceptance), original social behavior, first/subsequent iterations and the entire Master Plan §7 matrix. Generic samples do not replace any other applicable acceptance or prove product completion.

### 2026-09-08 product correction: chat-native Skill experience

The Owner clarified that `V3-WORKBENCH` is a capability inside the existing chat
interface, not a separate project/form workbench. In multi-step Skill mode the
layout is chat history on the left, AI conversation in the middle and configured
step information on the right. Free chat and ordinary non-workflow document
Skills have no step sidebar or empty sidebar space. The existing task ID and
all dependencies above remain unchanged.

The [chat-native interaction specification](tasks/V3-standard-skills.md#chat-skill-experience)
and [acceptance cases](tasks/V3-standard-skills.md#chat-skill-acceptance) require
real entry-point separation, multi-turn conversation/result linkage, history
restoration and scope isolation. Preserve shared results, explicit confirmations,
versions, restricted evidence, original billing and unknown-result recovery.
Existing `/workbench` projects and links must retain their data and recovery
identity as the user experience is integrated; do not build a second backend.

This is a specification correction only, not an implementation-completion record
or authorization to start another Launch node. The merged #387 technical/local
validation remains historical evidence and does not prove the corrected chat
experience. `V3-M3` must include this interaction acceptance without removing any
existing Master Plan §7 requirement. Real-provider, research, pricing/terms,
retention/deletion and external-environment validation remain separate.

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
