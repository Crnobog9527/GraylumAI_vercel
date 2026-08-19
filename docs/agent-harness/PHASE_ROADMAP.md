# Agent Harness Phase Roadmap

## Phase 0: Foundation

Create the control-plane foundation:

- Branch and role rules.
- Planner, Generator, Evaluator, and Release Auditor prompts.
- Sprint contract schema.
- Evaluator report schema.
- Release Auditor report schema.
- PR template.
- Agent task issue template.
- CI and Security workflow trigger coverage for `main`, `staging`, and `develop` where required.

Phase 0 does not add auto-merge, Codex Action workflows, `.codex/hooks.json`, business-code changes, DB migrations, Stripe actions, cron triggers, or external service settings changes.

## Phase 1: Evaluator-only

Enable independent Evaluator use on existing PRs under `AUDITED_STATE_READ_ONLY`.

Evaluator checks contract compliance, changed files, validation evidence, forbidden actions, and risk classification. It does not edit code, repository state, PR metadata, reviews, issues, merge state, deployments, or external systems.

The sole write exception is `REPORT_COMMENT_PERSISTENCE_EXCEPTION`: after a completed canonical audit, the Evaluator may append exactly one top-level PR Conversation comment containing the complete canonical structured report only when the Owner authorization for that exact audit explicitly includes report persistence. `read-only` does not suppress an already authorized report comment, but generic audit wording or silence does not authorize one. The comment is `REPORT_COMMENT_IS_EVIDENCE_ONLY` and never authorizes remediation, mark-ready, merge, deploy, production, Issue lifecycle mutation, a next gate, or Owner authorization.

Evaluator `PASS` reports must bind a non-null exact base SHA and exact audited head SHA. If exact base SHA cannot be determined, the audit must return `BLOCKED`; a `BLOCKED` report may use `base_sha: null` only when missing base identity is the blocking condition.

Evaluator reports must include stable machine-readable decision fields, exact report/PR/base/head identity fields, and Chinese owner-facing summary fields. A blocked report must include a concrete `stop_reason`.

## Phase 2: Generator Low-risk

Allow Generator to implement low-risk tasks with a Planner contract.

Generator may only edit allowed files. Evaluator must review before the next gate. Evaluator report persistence remains explicitly Owner-authorized, evidence-only, and does not itself create the next gate.

## Phase 3: Staging Auto-merge Low-risk

Consider staging auto-merge only for low-risk tasks after:

- Contract exists.
- Generator completed only allowed scope.
- Evaluator pass.
- Release Auditor pass.
- Required checks pass.
- No production relevance or production gate remains separate and blocked.

Production never auto-merges.

Release Auditor is also `AUDITED_STATE_READ_ONLY` with the same sole `REPORT_COMMENT_PERSISTENCE_EXCEPTION`: after a completed canonical audit it may append exactly one complete top-level PR Conversation report comment bound to the exact audited PR/base/head only when the Owner authorization for that exact run explicitly includes report persistence. Generic audit wording or silence does not authorize the write. The comment is evidence only and is not merge, mark-ready, deployment, production, Issue-lifecycle, next-gate, or Owner authorization.

Release Auditor `PASS` reports must bind a non-null exact base SHA and exact audited head SHA. If exact base SHA cannot be determined, the audit must return `BLOCKED`.

Release Auditor reports must include stable machine-readable decision fields and Chinese owner-facing summary fields. `can_release_to_production` must remain `false` unless a separate production owner gate is explicitly authorized.

## Phase 4: High-risk Semi-automation

Support high-risk tasks with semi-automation only.

High-risk tasks require:

- Contract.
- Evaluator pass bound to exact non-null base/head identity.
- Release Auditor pass bound to the same exact non-null base/head identity.
- Explicit owner authorization.

Canonical Evaluator and Release Auditor report comments are durable evidence for these gates only when explicitly authorized for persistence, and they cannot satisfy or replace the explicit Owner authorization requirement.

Production remains a separate owner release gate.