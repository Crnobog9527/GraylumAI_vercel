# Graylum Launch Plan — START HERE

This file is the Launch discovery index. It stores no task authorization,
runtime ledger, or completion state.

## Entry points

- Authoritative current `staging` `AGENTS.md`.
- [Master Plan v10.1 with approved V3 amendments](Graylum_Master_Plan_v10.1.md).
- [V3 specification and V3.1 first delivery](tasks/V3-standard-skills.md).
- `docs/launch/plan-core.md`.
- Stable task specifications under `docs/launch/tasks/`.

## Product specification vs execution authority

The Master Plan and Launch task specifications define product WHAT, dependencies,
acceptance criteria, validation requirements, and Definition of Done. They do not
by themselves authorize repository mutation, merge, database/provider access, or
production action.

Historical process wording retained inside product documents about Development
Policy, G1A/G2, Sprint Contracts, Gates, receipts, Bookkeepers, Evaluators,
Release Auditors, or Harness lifecycle is historical context only after the
clean-slate cutover. It has no execution authority. Current execution follows the
authoritative `staging` `AGENTS.md`.

Do not delete, weaken, or ignore a product decision, technical requirement,
acceptance criterion, or Definition of Done merely because adjacent historical
process wording has been retired.

## Discovery protocol

1. Fresh-read repository identity, exact current refs, and authoritative current
   `staging` `AGENTS.md`.
2. Read `plan-core.md`, including the approved V3 dependencies, and derive ready
   candidates from live completion evidence. Historical baseline merges alone do
   not make the extended product ready for release.
3. Treat the ready-candidate set as discovery data only; readiness never selects
   or authorizes a task by itself.
4. Read-only discovery, comparison, and readiness audits need no task selection.
   Before starting a new Launch implementation, require explicit Owner selection
   of a named task from the current ready-candidate set. Continuing the same
   selected task does not require reselection.
5. If the Owner-selected task is not currently ready, return
   `NO_PRODUCT_TASK_AUTHORIZED` with reason `OWNER_SELECTED_TASK_NOT_READY`.
6. After an eligible Owner selection, derive technical risk, scope, branch/PR,
   and validation under current `AGENTS.md`.
7. Verify exactly-one-writer before mutation.
8. If implementation is requested without an explicitly Owner-selected Launch
   task, return `NO_PRODUCT_TASK_AUTHORIZED`; discovery may still continue.
9. If task identity, readiness evidence, repository state, or writer occupancy is
   materially ambiguous or conflicting, return `BLOCKED_CONTEXT_NOT_VERIFIED`.
10. After the selected task completes, stop. Never automatically select or start
    the next Launch task.

Historical Issues, trackers, Gates, Harness records, completion prose, and model
recommendations may provide evidence or context. They cannot select the next task
or create repository, merge, production, or external-system authority.
