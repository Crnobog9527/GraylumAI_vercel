# STG-FIX Sprint Contract Candidate

`CANDIDATE_NOT_ACTIVE`

This file is the canonical STG-FIX Sprint Contract candidate. It is not an implementation authorization and does not select STG-FIX as the current task. The current Issue #314 is the materialization gate only; a future dedicated STG-FIX Task Issue and exact Owner gate must bind this contract before execution.

```yaml
contract_id: STG-FIX
issue:
  number: 314
  url: https://github.com/Crnobog9527/GraylumAI_vercel/issues/314
  title: "[Governance][Dedicated Task] Graylum Launch Tracking / Harness Control convergence"
owner_goal: >-
  Prepare a bounded, idempotent database migration candidate that restores the
  staging objects required by the accepted product plan and records reproducible
  staging-to-production structure-parity evidence without changing production.
risk_class: high
base_branch: origin/staging
target_branch: staging
allowed_scope:
  files:
    - packages/db/migrations/<freshly-bound-migration>.sql
    - docs/launch/evidence/STG-FIX-STRUCTURE-COMPARISON.md
  commands:
    - git status --short --branch
    - git diff --check
    - git diff --name-only
    - rg -n "IF NOT EXISTS|CREATE OR REPLACE" packages/db/migrations/<freshly-bound-migration>.sql
    - pnpm test:api
    - read-only structure-fingerprint queries for the required staging objects
    - a second staging migration application proving idempotency
  services:
    - CI test runner
    - Supabase staging database, only under a later exact Owner implementation gate
    - Supabase production database, read-only parity evidence only under a separate Owner gate
forbidden_actions:
  - Modify any path outside the exact future bound allowlist.
  - Infer or self-select a migration filename, migration ownership, or task authorization.
  - Edit an already-applied migration, use db:push, or perform an uncontrolled migration.
  - Apply a migration to production or access production data without a separate Owner gate.
  - Push directly to main or staging, merge, auto-merge, deploy, or perform a production smoke test.
  - Change Supabase, Stripe, Vercel, environment, project, branch-protection, or required-check settings.
  - Modify Issue #263, Issue #270, Issue #314, the Launch Plan candidate, or Harness runtime surfaces.
  - Implement a runtime lifecycle classifier, stale/reclaim engine, dispatcher, event ledger, control-plane-sync, automatic remediation, or autonomous task selection.
  - Copy a second DoD/checklist into a Task Issue or use an Issue checklist as completion truth.
implementation_plan:
  - Fresh-read repository identity, refs, policy binding, the dedicated Task Issue, and the exact future Owner gate.
  - Resolve the next migration identity and inspect the target staging definitions before writing the bounded migration.
  - Use idempotent DDL for the required function, tables, policies, and grants; preserve unrelated definitions and keep the migration expand-only.
  - Capture reproducible structure fingerprints and run the required validation only inside the separately authorized STG-FIX lane.
required_validation:
  - command: git diff --check
    purpose: Confirm the candidate diff has no whitespace errors.
    required: true
  - command: git diff --name-only
    purpose: Confirm the implementation diff contains only the exact future STG-FIX allowlist.
    required: true
  - command: rg -n "IF NOT EXISTS|CREATE OR REPLACE" packages/db/migrations/<freshly-bound-migration>.sql
    purpose: Confirm every new DDL operation is explicitly idempotent.
    required: true
  - command: pnpm test:api
    purpose: Confirm the application API test suite remains green after the staging change.
    required: true
  - command: read-only structure-fingerprint queries for function, table, policy, and grant parity
    purpose: Compare staging and production definitions without rewriting production.
    required: true
  - command: second staging migration application
    purpose: Prove the migration is a no-op on its second application.
    required: true
evaluator_checklist:
  - Confirm the exact task-card blob, fresh refs, dedicated Task Issue, and Owner gate are bound before implementation.
  - Confirm changed paths, commands, services, DoD, required validation, forbidden actions, and stop conditions match this contract.
  - Confirm all required validation has machine evidence and the structured conclusion is PASS; FAIL or BLOCKED does not satisfy the gate.
  - Confirm no production, external-platform, merge, direct protected-branch, or Launch Plan activation action occurred.
release_auditor_checklist:
  - Confirm the change is a staging-only candidate and production relevance is handled as a separate Owner gate.
  - Confirm forward-only rollback, remaining risks, exact deployment identity, and structure-parity evidence are recorded before any promotion consideration.
  - Confirm this candidate does not authorize merge, staging database application, production database application, or staging-to-main promotion.
production_relevance:
  status: direct
  owner_gate_required: true
stop_conditions:
  - Any required path, command, service, or validation expands beyond this contract.
  - The exact migration identity is unavailable, already occupied, conflicting, or cannot be bound by fresh evidence.
  - Any structure fingerprint differs; do not rewrite production to force parity.
  - Any required validation fails for a cause outside this contract.
  - Fresh repository identity, refs, policy binding, task identity, Owner gate, or branch posture is missing, stale, ambiguous, or conflicting.
  - Another active STG-FIX implementation, equivalent PR, or competing writer appears.
  - Progress requires production, external-platform, environment, merge, deployment, or protected-branch action.
  - The work would modify #263, #270, #314, the Launch Plan candidate, or any runtime control-plane surface.
```

## Definition of Done

The following is the only STG-FIX completion definition in the candidate:

1. The exact future-bound migration and structure comparison record are the only implementation paths changed.
2. The migration is idempotent and adds the required `claim_daily_checkin` function, `application_logs` table, and `diagnostic_results` table without altering unrelated definitions.
3. Function parity covers `pg_get_functiondef(oid)` hash, owner, and `proacl`.
4. Table parity covers columns, `relrowsecurity`, `relforcerowsecurity`, constraints, indexes, and triggers.
5. Policy parity covers policy name, command, roles, permissive mode, `qual`, and `with_check`.
6. Permission parity covers sorted `information_schema.role_table_grants` output.
7. The second staging application is a no-op with no error, and `pnpm test:api` passes.
8. The evidence record contains exact refs, object fingerprints, validation results, and no secret values; production application remains a separate Owner-gated action.

This candidate remains `CANDIDATE_NOT_ACTIVE`; its DoD does not authorize implementation, database access, merge, or promotion.
