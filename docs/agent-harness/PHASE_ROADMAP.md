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

## Phase 0.5: Trusted Automation Boundary + GPT-5.6 Calibration

Phase 0.5 precedes Phase 1. It hardens the workflow supply chain, keeps PR workflows secretless, separates trusted staging E2E from PR E2E, defines prompt-injection and model-calibration policy, and records Golden Evals.

Phase 1 remains blocked until the owner resolves the external baseline risks documented in `SECURITY_BASELINE.md`: GitHub branch protection/rulesets must protect `staging`, and Vercel Preview must not receive live or privileged credentials.

## Phase 1: Evaluator-only

Enable read-only Evaluator use on existing PRs.

Evaluator checks contract compliance, changed files, validation evidence, forbidden actions, and risk classification. It does not edit code.

Evaluator reports must include stable machine-readable decision fields and Chinese owner-facing summary fields. A blocked report must include a concrete `stop_reason`.

## Phase 2: Generator Low-risk

Allow Generator to implement low-risk tasks with a Planner contract.

Generator may only edit allowed files. Evaluator must review before the next gate.

## Phase 3: Staging Auto-merge Low-risk

Consider staging auto-merge only for low-risk tasks after:

- Contract exists.
- Generator completed only allowed scope.
- Evaluator pass.
- Release Auditor pass.
- Required checks pass.
- No production relevance or production gate remains separate and blocked.

Production never auto-merges.

Release Auditor reports must include stable machine-readable decision fields and Chinese owner-facing summary fields. `can_release_to_production` must remain `false` unless a separate production owner gate is explicitly authorized.

## Phase 4: High-risk Semi-automation

Support high-risk tasks with semi-automation only.

High-risk tasks require:

- Contract.
- Evaluator pass.
- Release Auditor pass.
- Explicit owner authorization.

Production remains a separate owner release gate.
