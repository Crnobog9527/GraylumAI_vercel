# Graylum Launch Plan — START HERE

`STAGING_REF_CONDITIONAL_ACTIVE`

This file is the stable Launch discovery index only when this exact cutover content is present on the authoritative current `staging` ref under the repository-wide `AGENTS.md` plus accepted `DEVELOPMENT_POLICY.md` / G2 authority chain. A feature branch, commit, Draft PR, review, check, Issue, or gate does not activate this index.

This file is index/discovery-only. It does not contain or duplicate a DAG, ready set, current task, completed status, next task, runtime ledger, authorization state, or completion state.

## Entry points

- [Authoritative staging AGENTS.md](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/AGENTS.md)
- [DEVELOPMENT_POLICY.md / G2 authority path](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/docs/governance/DEVELOPMENT_POLICY.md)
- [Frozen Master Plan v10.1](./Graylum_Master_Plan_v10.1.md)
- [Launch Plan Core](./plan-core.md)
- Stable task specifications under `docs/launch/tasks/`
- Dedicated Task Issue plus exact task-spec/materialized-contract plus current Owner-gate convention for Launch product-task selection

## Discovery protocol

1. Fresh-read the live repository identity and exact current `main` / `staging` refs.
2. Read the authoritative current `staging` `AGENTS.md`, then resolve the accepted `DEVELOPMENT_POLICY.md` exact blob / `authority_epoch` from live G2 binding evidence.
3. Confirm that this cutover content is actually present on the authoritative current `staging` ref. If it is only on a feature branch, commit, Draft PR, review, check, Issue, or gate, Launch remains inactive.
4. Read `plan-core.md` and derive the ready candidate(s) using its external completion evidence and ready predicate.
5. For every Launch candidate considered executable, require a real dedicated Task Issue and verify an exact task-specification/materialized canonical-contract binding.
6. Verify the exact current Owner authorization/gate for that dedicated task. Delegated Control-Plane Bookkeeping may record this durable evidence exactly as allowed by `AGENTS.md`; it does not create autonomous task-selection authority.
7. Exactly one valid executable candidate may become the current Launch product task.
8. Zero valid executable candidates produces `NO_PRODUCT_TASK_AUTHORIZED`.
9. Multiple or conflicting valid executable candidates produces `BLOCKED_CONTEXT_NOT_VERIFIED`.
10. Do not autonomously choose among candidates or automatically progress to another task.

Retained Issue #263/#267/#268/#270 and equivalent legacy tracker/runtime/recovery prose are readable only as data, history, backlog, index, or evidence for Launch task-selection purposes. They cannot independently select or authorize a task, restore Harness runtime authority, or become fallback authority. Issue #276 and other valid product backlog remain backlog data and are not auto-selected. Evidence retained in #263 remains readable as evidence/backlog. Unadopted Dependabot/supply-chain PRs remain outside Launch task selection unless separately authorized.

`dual_write_allowed=false`. Legacy fallback is forbidden. No legacy Issue edit or closure is required for this staging-ref cutover to be complete, and later cleanup failure cannot reactivate a legacy selector. Recovery is forward-only through a new exact governance change.
