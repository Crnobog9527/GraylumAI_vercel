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

Planner is read-only and writes a sprint contract only when separately authorized by the applicable task flow.

Generator implements only the approved sprint contract.

Evaluator is independent and `AUDITED_STATE_READ_ONLY`: it verifies the PR against the contract and must not edit code, repository files, branches, PR metadata, reviews, issues, merge state, deployments, or external systems. Its sole write exception is `REPORT_COMMENT_PERSISTENCE_EXCEPTION` below.

Release Auditor is independent and `AUDITED_STATE_READ_ONLY`: it checks release readiness, branch posture, checks, and production relevance and must not edit audited state, submit reviews, mark ready, merge, deploy, mutate issues, or mutate external systems. Its sole write exception is `REPORT_COMMENT_PERSISTENCE_EXCEPTION` below.

Owner defines business goals and production authorization. Owner does not act as the code reviewer.

## REPORT_COMMENT_PERSISTENCE_EXCEPTION

After a canonical Evaluator or Release Auditor completes an audit of an unambiguously identified PR, that audit role may append exactly one top-level PR Conversation comment containing the complete canonical structured report for that run.

For canonical audit tasks, `read-only`, `strictly read-only`, and equivalent wording mean `AUDITED_STATE_READ_ONLY`. They do not suppress this sole report-output write. Only an explicit Owner instruction such as `do not persist/post the report`, or an unambiguously equivalent instruction for that run, disables report persistence.

The persisted comment must bind the exact PR number, base branch, base SHA when determinable, head branch, exact audited head SHA, report role, `report_id`, `machine_decision`, and every field required by the applicable canonical report schema.

`REPORT_COMMENT_IS_EVIDENCE_ONLY`: the comment is evidence only. It cannot authorize remediation, mark-ready, merge, deploy, production, Issue closure or lifecycle mutation, a next gate, or Owner authorization. The exception does not permit code/repository edits, branch/commit writes, PR metadata changes, `APPROVE` / `REQUEST_CHANGES` / `COMMENT` review submissions, inline review comments, comment editing/deletion, merges, deployments, or external-system mutations.

If exact PR identity or exact audited head cannot be verified, the canonical report is incomplete, persistence fails, or Owner disabled persistence for the run, fail closed on persistence and do not substitute another GitHub write.

## Report Contract

Evaluator and Release Auditor reports must be both owner-readable and machine-readable.

Owner-facing fields must be in Chinese and include:

- `owner_summary_zh`: one sentence with the decision summary.
- `owner_next_action_zh`: one sentence describing what the owner needs to do now.

Machine-readable fields must remain stable for automation:

- `report_role`: `EVALUATOR` or `RELEASE_AUDITOR`.
- `report_id`: unique report identifier.
- `machine_decision`: `PASS`, `FAIL`, or `BLOCKED`.
- exact PR identity, base/head branch, exact audited head SHA, and base SHA when determinable.
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

The report-comment exception never changes these forbidden-action boundaries.

## Phase 0 Boundary

Phase 0 only creates the control-plane foundation: rules, prompts, schemas, templates, documentation, and workflow trigger coverage. It is not automatic development and it is not automatic merge.
