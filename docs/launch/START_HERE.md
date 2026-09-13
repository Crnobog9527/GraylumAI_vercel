# Graylum Launch Plan — START HERE

This file is the Launch discovery index. It stores no task authorization,
runtime ledger, or completion state.

## Entry points

- Authoritative current `staging` `AGENTS.md`.
- [Master Plan v10.2 OPC Growth Agent amendment](Graylum_Master_Plan_v10.2_OPC_Growth_Agent_Amendment.md): Owner-approved product re-baseline dated 2026-09-13. Where it explicitly conflicts with earlier chat, project, Skill UI, context, routing, retention or multi-model billing assumptions, the amendment controls. It does not select or start an implementation task.
- [Detailed V3 OPC Growth Agent architecture](tasks/V3-OPC-growth-agent-architecture.md): positioning flow, account projects, work items, Agent SDK Sessions, top-navigation Skill marketplace, composer-integrated connectors, model roles, Fusion, provider-authoritative billing, UI routes and legacy cleanup.
- [Master Plan v10.1 baseline](Graylum_Master_Plan_v10.1.md): all non-conflicting payment, auth, security, release, acceptance and Definition of Done requirements remain in force.
- [Historical V3 specification and V3.1 delivery](tasks/V3-standard-skills.md): retain non-conflicting Skill package, artifact, evidence, version, report, permission and validation requirements.
- [Generic Skill foundation and configurable workbench](tasks/V3-standard-skills.md#generic-skill-workbench): retained where consistent with the 2026-09-13 amendment. The social six-step Skill remains the business source; the new architecture changes the product journey and host runtime rather than replacing its business method.
- `docs/launch/plan-core.md`.
- Stable task specifications under `docs/launch/tasks/`.

PR #388 was closed without merge because its 2026-09-08 assumption—an existing global chat as the primary workflow without the newly approved account-project journey—was superseded by the 2026-09-13 Owner decision.

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
2. Read the 2026-09-13 Master Plan amendment and detailed OPC architecture before
   relying on older V3 interaction, routing, retention or billing assumptions.
3. Read `plan-core.md`, including the approved V3 dependencies, and derive ready
   candidates from live completion evidence. Historical baseline merges alone do
   not make the extended product ready for release.
4. Treat the ready-candidate set as discovery data only; readiness never selects
   or authorizes a task by itself.
5. Read-only discovery, comparison, and readiness audits need no task selection.
   Before starting a new Launch implementation, require explicit Owner selection
   of a named task from the current ready-candidate set. Continuing the same
   selected task does not require reselection.
6. If the Owner-selected task is not currently ready, return
   `NO_PRODUCT_TASK_AUTHORIZED` with reason `OWNER_SELECTED_TASK_NOT_READY`.
7. After an eligible Owner selection, derive technical risk, scope, branch/PR,
   and validation under current `AGENTS.md`.
8. Verify exactly-one-writer before mutation.
9. If implementation is requested without an explicitly Owner-selected Launch
   task, return `NO_PRODUCT_TASK_AUTHORIZED`; discovery may still continue.
10. If task identity, readiness evidence, repository state, or writer occupancy is
    materially ambiguous or conflicting, return `BLOCKED_CONTEXT_NOT_VERIFIED`.
11. After the selected task completes, stop. Never automatically select or start
    the next Launch task.

Historical Issues, trackers, Gates, Harness records, completion prose, and model
recommendations may provide evidence or context. They cannot select the next task
or create repository, merge, production, or external-system authority.
