# Graylum Agent Harness

The Graylum Agent Harness is a GitHub issue driven control plane for bounded engineering work. It separates planning, implementation, validation, and release readiness into distinct roles:

1. Planner
2. Generator
3. Evaluator
4. Release Auditor

The harness does not make production decisions. Owner authorization remains required for production releases and high-risk gates.

## Branch Model

- `main` is the production release branch.
- `staging` is the pre-production integration branch.
- Agent branches start from the latest `origin/staging` by default.
- Agent pull requests target `staging` by default.
- Production promotion is a separate owner-authorized release gate.

## Role Model

Planner is read-only and writes a sprint contract.

Generator implements only the approved sprint contract.

Evaluator is read-only and verifies the PR against the contract.

Release Auditor is read-only and checks release readiness, branch posture, checks, and production relevance.

Owner defines business goals and production authorization. Owner does not act as the code reviewer.

## Report Contract

Evaluator and Release Auditor reports must be both owner-readable and machine-readable.

Owner-facing fields must be in Chinese and include:

- `owner_summary_zh`: one sentence with the decision summary.
- `owner_next_action_zh`: one sentence describing what the owner needs to do now.

Machine-readable fields must remain stable for automation:

- `machine_decision`: `PASS`, `FAIL`, or `BLOCKED`.
- `risk_level`: `low`, `medium`, `high`, or `production`.
- `can_merge_to_staging`: boolean.
- `can_release_to_production`: boolean.
- `forbidden_actions_observed`: boolean.
- `required_human_authorization`: `none`, `owner`, or `production_owner_gate`.
- `evidence_links`: GitHub checks, PR, issue, logs, and reports.
- `stop_reason`: required when blocked.

## Permanent Forbidden Actions

The harness must not perform:

- Production deployment or production smoke.
- Supabase production DB access.
- Stripe live action.
- Real checkout, payment, refund, cancel, or webhook replay.
- Vercel, Supabase, or Stripe env/project settings changes.
- Uncontrolled DB migration.
- Uncontrolled RPC, RLS, schema, or grant modification.
- Cron trigger.
- High-risk issue closure.

## Phase 0 Boundary

Phase 0 only creates the control-plane foundation: rules, prompts, schemas, templates, documentation, and workflow trigger coverage. It is not automatic development and it is not automatic merge.

## Phase 0.5 Boundary

Phase 0.5 establishes trusted automation boundaries before any Evaluator-only rollout. See `TRUST_BOUNDARIES.md`, `THREAT_MODEL.md`, `MODEL_POLICY_GPT56.md`, `GOLDEN_EVALS.md`, and `SECURITY_BASELINE.md`. Phase 1 must remain blocked until the owner resolves the documented GitHub branch-protection and Vercel Preview credential-scope risks.
