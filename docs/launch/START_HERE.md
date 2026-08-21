# Graylum Launch Plan — START HERE

`STAGING_REF_CONDITIONAL_ACTIVE`

This file is a Launch discovery index only when this exact content is present on the authoritative current `staging` ref under live `AGENTS.md` plus the accepted `DEVELOPMENT_POLICY.md` / G2 authority chain. A feature branch, commit, Draft PR, review, check, Issue, gate, ready set, or model conclusion cannot activate or authorize Launch work.

This file stores no current task, runtime ledger, authorization state, or completion state.

## Entry points

- Authoritative current `staging` `AGENTS.md`.
- Accepted `docs/governance/DEVELOPMENT_POLICY.md` / G2 binding.
- Frozen Master Plan v10.1.
- `docs/launch/plan-core.md`.
- Stable task specifications under `docs/launch/tasks/`.

## Discovery protocol

1. Fresh-read repository identity and exact current `main` / `staging` refs.
2. Read authoritative current `staging` `AGENTS.md` and resolve the accepted policy blob / `authority_epoch` from live G2 evidence.
3. Read `plan-core.md` and derive ready candidates from live completion evidence.
4. Treat the ready-candidate set as discovery data only.
5. Require the Owner to explicitly select the named Launch task before any planning or implementation begins.
6. Classify the Owner-selected task using current `AGENTS.md`:
   - ordinary Launch work may use direct Owner authorization plus a bounded module/risk envelope;
   - high-risk Launch work requires the durable task record, canonical contract, and bounded gate defined by `AGENTS.md`.
7. Verify exactly-one-writer and the exact branch/PR state before mutation.
8. If no Launch task is explicitly Owner-selected, return `NO_PRODUCT_TASK_AUTHORIZED`.
9. If task identity, authorization, or writer state conflicts, return `BLOCKED_CONTEXT_NOT_VERIFIED`.
10. After the authorized task/transition completes, stop. Never automatically select or progress to the next Launch task.

A Dedicated Task Issue is therefore not a universal Launch prerequisite. It remains required for high-risk work and available when the Owner wants a durable record.

Delegated Control-Plane Bookkeeping may record a high-risk durable task/gate exactly as `AGENTS.md` permits, but it never creates task-selection authority.

Retained Issues, trackers, Harness runtime prose, historical gates, and backlog items are evidence/history only. They cannot select a task, restore a legacy writer, or create fallback authority.

`dual_write_allowed=false`. Recovery is forward-only. No cleanup failure or historical state can reactivate automatic task selection.
