# Graylum Agent Harness — Frozen Minimal Operating Model

## Status

Agent Harness / Orchestrator expansion is frozen until Graylum completes its first official launch and the Owner later performs an explicit re-evaluation.

This document now describes only the minimal role guidance that supports product delivery. It is not a separate task selector, authorization source, runtime ledger, dispatcher, receipt engine, or autonomous control plane. GitHub live state plus authoritative `AGENTS.md` and the accepted policy/G2 binding remain the authority chain.

Do not build or advance Phase 0.6, `control-plane-sync`, automatic repair, low-risk auto-merge, OpenSpec, or a new Harness service/bot/ledger/dispatcher/receipt engine/Orchestrator while the freeze is active.

## Ordinary product flow

The normal flow is:

`Owner goal -> Codex Draft PR -> required CI/Security -> ChatGPT adversarial semantic review -> browser/staging validation when applicable -> Owner-authorized merge`

Ordinary tasks do not require by default:

- a Dedicated Task Issue;
- a canonical Sprint Contract;
- a persisted canonical Evaluator report;
- a Release Auditor report.

Ordinary scope is expressed as allowed modules / risk envelope plus directly necessary callers and tests. Crossing into another module, protected/high-risk surface, dependency/supply-chain work, database/auth/payment work, production/external systems, or a different risk class requires a new Owner decision.

## High-risk flow

High-risk work retains durable evidence and role separation:

1. Durable task record and canonical Sprint Contract.
2. Bounded Generator implementation on a feature branch from exact `staging`.
3. Required CI/Security and validation on the exact head.
4. Independent adversarial Evaluator PASS bound to exact base/head.
5. The High-Risk Validation Floor: current GitHub CI, relevant lint/typecheck/test evidence, runtime Vercel staging deployment status, affected-flow smoke/browser evidence, rollback plan, and remaining risks before `staging -> main` promotion.
6. Category-specific staging validation: Supabase staging for DB/RLS/RPC/migration work, Stripe test mode for payment/billing work, staging auth-flow validation with non-production/test identities for auth work, and Vercel staging environment/configuration validation for runtime env/config changes. Genuinely docs-only/non-runtime governance work may record `NOT_APPLICABLE` only with a concrete reason.
7. Deterministic Release Auditor/Release Gate PASS bound to the same exact base/head.
8. Fresh explicit Owner authorization for the exact next GitHub transition.

The Release Auditor must fail or block when a required High-Risk Validation Floor item is absent; it must not reinterpret a missing item as optional.

An emergency production hotfix directly to `main` requires explicit Owner authorization and a mandatory synchronization of the same exact fix back into `staging` through the protected PR path. No direct protected-branch push or unrelated bundled change is allowed, and the hotfix lifecycle remains incomplete while that resync is unresolved under fresh Owner authorization and live checks.

Retained schemas remain the high-risk structured evidence formats:

- `SPRINT_CONTRACT_SCHEMA.md`
- `EVALUATOR_REPORT_SCHEMA.md`
- `RELEASE_AUDITOR_REPORT_SCHEMA.md`

A candidate that changes governance/Harness/policy prompts cannot use candidate-side rules to audit or release itself; base-side authoritative rules govern that candidate's lifecycle.

## Role boundaries

### Planner

Read-only. For ordinary work it produces a bounded implementation brief. For high-risk work it produces/validates the canonical durable contract. It never selects the next Launch task.

### Generator

Implements only the Owner-authorized ordinary risk envelope or exact high-risk contract. It creates a Draft PR to `staging` and stops at the authorized transition. It never auto-merges or expands risk/scope silently.

### Evaluator

Independent and `AUDITED_STATE_READ_ONLY`. It is adversarial: it actively tries to falsify correctness, completeness, scope compliance, validation quality, and security assumptions.

Ordinary Evaluator output may be concise and need not be persisted. High-risk output uses the canonical schema and exact base/head binding.

### Release Auditor

High-risk deterministic release-state gate. It checks exact identity, checks/validation, scope/forbidden actions, staging evidence, unresolved findings, writer state, mergeability, and production relevance. It does not redo semantic code review and it never merges.

### Owner

Selects the task and authorizes exact state-changing transitions. Readiness, priority, or plan order never substitutes for Owner task selection. The Owner may authorize a fresh-context Agent to execute an exact GitHub transition after live predicates pass; this is still Owner-controlled and is not autonomous merge.

## Security and release invariants

Preserve:

- GitHub-live authority;
- staging-first integration;
- protected branches and required CI/Security;
- exact base/head binding for audits/transitions;
- exactly-one-writer and `dual_write_allowed=false`;
- no direct protected-branch push;
- no autonomous merge or task progression;
- separate strict Owner gates for main/production and DB/RLS/auth/payment/secrets/env/external-system actions.

`SECURITY_BASELINE.md`, `THREAT_MODEL.md`, and `TRUST_BOUNDARIES.md` remain security reference material. Their open/future workstreams do not authorize Harness expansion during the freeze.

## Canonical report persistence

For high-risk audits, canonical report comments are evidence only. Persistence requires explicit Owner authorization for that exact audit run. Without it, return the report without a GitHub write.

A report comment never authorizes remediation, mark-ready, merge, deployment, production, Issue lifecycle mutation, or another task.
