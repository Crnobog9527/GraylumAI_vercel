# STG-FIX Task Specification

This file defines the product and technical requirements for STG-FIX. It does not
authorize implementation, staging database mutation, production access, merge,
or release.

Execution follows authoritative current `staging` `AGENTS.md` after the Owner
explicitly selects STG-FIX and Launch readiness is verified.

```yaml
task_id: STG-FIX
owner_goal: >-
  Prepare a bounded, idempotent database migration candidate that restores the
  staging objects required by the accepted product plan and records reproducible
  staging-to-production structure-parity evidence without changing production.
risk_hint: high
intended_repository_scope:
  files:
    - packages/db/migrations/<migration-resolved-from-live-repository-at-execution-time>.sql
    - docs/launch/evidence/STG-FIX-STRUCTURE-COMPARISON.md
technical_requirements:
  - Resolve migration identity from live repository state; do not edit an already-applied migration.
  - If the intended migration identity is occupied, ambiguous, or conflicting, resolve a fresh valid identity before writing.
  - Do not use db:push or an uncontrolled migration path.
  - Keep the migration expand-only and idempotent.
  - Restore the required claim_daily_checkin function, application_logs table, and diagnostic_results table without altering unrelated definitions.
  - Preserve unrelated function, table, policy, grant, index, trigger, and ownership definitions.
  - Treat any staging/production structure-fingerprint difference as evidence; never rewrite production merely to force parity.
validation_requirements:
  - git diff --check
  - exact changed-file inspection
  - rg -n "IF NOT EXISTS|CREATE OR REPLACE" packages/db/migrations/<resolved-migration>.sql
  - pnpm test:api
  - read-only structure-fingerprint queries for the required staging objects
  - a second staging migration application proving idempotency
  - structure-parity evidence covering the function, tables, policies, and grants defined below
external_boundaries:
  - Staging database validation must follow current AGENTS.md and the Owner-selected task scope.
  - Production mutation is forbidden unless separately and explicitly Owner-authorized.
  - Any production read-only parity inspection requires explicit Owner approval before that production access.
  - Merge, main promotion, provider configuration, and production release are separate decisions under current AGENTS.md.
  - Evidence must contain no secret values.
```

## Definition of Done

1. The resolved migration and structure comparison record are the only intended
   implementation paths changed.
2. The migration is idempotent and adds the required `claim_daily_checkin`
   function, `application_logs` table, and `diagnostic_results` table without
   altering unrelated definitions.
3. Function parity covers `pg_get_functiondef(oid)` hash, owner, and `proacl`.
4. Table parity covers columns, `relrowsecurity`, `relforcerowsecurity`,
   constraints, indexes, and triggers.
5. Policy parity covers policy name, command, roles, permissive mode, `qual`, and
   `with_check`.
6. Permission parity covers sorted `information_schema.role_table_grants` output.
7. The second staging application is a no-op with no error, and `pnpm test:api`
   passes.
8. The evidence record contains exact refs, object fingerprints, validation
   results, and no secret values; production application remains separately
   Owner-authorized.
