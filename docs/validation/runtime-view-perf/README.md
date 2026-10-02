# RUNTIME-VIEW-PERF

Risk: high (database RPC and migration). Owner authorized local diagnosis and implementation only;
merge and remote migration application require separate Owner approval. No staging database access,
real model calls, frontend changes, or independent review requested by this task.

Baseline: staging `ecf73b428e1f6018996b5ab5424b3389fdaf752b` (through migration 0157).
Evidence: https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5949917817

## Handoff

- Done: repository, baseline, applicable policy, required checks, open PRs and local writer context verified.
- Next: build a disposable local PostgreSQL 17 database from repository migrations; measure 15/50/100/300
  execution sessions with EXPLAIN ANALYZE and function timing; publish diagnosis and proposal before implementation.
- Blockers: none identified. Independent review will be arranged by the controller after implementation.
- Validation: NOT_RUN. No performance or equivalence claim yet.

## Acceptance

Compute history availability once per distinct execution per selection/view. Keep all current permission
checks, locks, revocation/erasure/disable semantics and byte-identical runtime_view JSON. Investigate
repeated queries, indexes and exception overhead before choosing the smallest fix. Assess pagination
separately; frontend implementation is reserved for Claude. At up to 100 executions, local runtime_view
and runtime_session_items must each finish within 1 second. New migrations start at 0158 with source MD5
checks, rollback guidance, idempotence and built fingerprint verification.
