# Graylum Launch Plan — START HERE

`CANDIDATE_NOT_ACTIVE`

This file is an index only. It does not contain a DAG, ready set, current task, completed status, next task, runtime state, or authorization.

## Entry points

- [Frozen Master Plan v10.1](./Graylum_Master_Plan_v10.1.md)
- [Launch Plan Core candidate](./plan-core.md)
- Dedicated Task Issue and Owner-gate convention (resolved from live authority)
- [Authoritative staging AGENTS.md](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/AGENTS.md)
- [DEVELOPMENT_POLICY.md / G2 authority path](https://github.com/Crnobog9527/GraylumAI_vercel/blob/staging/docs/governance/DEVELOPMENT_POLICY.md)

## Discovery protocol

1. Read `plan-core.md`.
2. Derive the ready candidate(s) using its external completion evidence and ready predicate.
3. For each candidate task ID, locate the matching open dedicated Task Issue when required by live authority or task risk.
4. Verify the exact task-specification blob is bound to the materialized canonical contract.
5. Verify the current Owner authorization and bounded gate.
6. Exactly one valid candidate becomes the current executable task.
7. Zero valid candidates produces `NO_PRODUCT_TASK_AUTHORIZED`.
8. Multiple or conflicting valid candidates produces `BLOCKED_CONTEXT_NOT_VERIFIED`.
