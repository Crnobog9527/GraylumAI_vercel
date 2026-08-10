# GraylumAI Agent Rules

## Authoritative Startup and Policy Binding

This section is the repository-level startup authority. It takes precedence over any conflicting retained prose in this file or in legacy workflow material.

Every fresh ChatGPT/Codex window must recover execution authority from GitHub live state in this order:

1. Verify the repository identity and current `main` and `staging` refs.
2. Read this authoritative `AGENTS.md` from the verified live repository.
3. Resolve the accepted `docs/governance/DEVELOPMENT_POLICY.md` exact blob and `authority_epoch` from live `G2_POLICY_BINDING_ACCEPTED` evidence.
4. Resolve the current dedicated Task Issue from GitHub live state.
5. Verify a separate explicit Owner receipt for the exact next executable gate.
6. Only after all five identities and bindings are present, current, unambiguous, and non-conflicting may the authorized mutation occur.

Missing, stale, ambiguous, conflicting, or locally inferred identity fails closed. The existence of a task, branch, prompt, local file, screenshot, prior conversation, or issue alone never grants executable permission. Before an accepted G2 policy binding exists, the repository remains fail-closed and legacy authority must not be restored.

Class-wide precedence is mandatory. Retained `.agents/**`, `task.json`, `progress.md`, `findings.md`, `task_plan.md`, Manus material, templates, Codex prompts, tracker prose, and history are `non-authoritative / derived / historical`. They cannot independently produce current task selection, a receipt, authorization, executable permission, state-writing authority, commit permission, merge permission, deployment permission, or external mutation permission. Their presence does not create a fallback path.

## Branch And Release Policy

GraylumAI is a live production application. Treat `main` as the production release branch and `staging` as the required pre-production integration branch.

Default workflow for all code changes:

1. Start from a clean worktree.
2. Fetch remote state and confirm `staging` is current before starting.
3. Create feature branches from `origin/staging`, not from `main`, unless the owner explicitly authorizes a production hotfix.
4. Open pull requests into `staging` first.
5. Let the Vercel staging project deploy the `staging` branch.
6. Verify the staging deployment before promoting to production.
7. Promote with a separate pull request from `staging` into `main`.
8. Let the Vercel production project deploy `main`.

Do not open feature, dependency, database, billing, auth, Stripe, or UI pull requests directly into `main` unless the owner explicitly says this is an emergency hotfix.

## Required Validation Before Main

Before any `staging` to `main` promotion, verify and report:

- GitHub CI status.
- Local or CI lint/typecheck/test results relevant to the change.
- Vercel staging deployment status.
- Manual smoke test results for affected flows.
- Rollback plan.
- Remaining risks.

For payment, billing, auth, Supabase, RLS, or migration work, staging validation must include the relevant staging service:

- Supabase staging database for DB/RLS/RPC changes.
- Stripe test mode for payment changes.
- Vercel staging environment variables for runtime config changes.

## Hotfix Exception

Emergency production hotfixes are allowed only with explicit owner approval in the task. If a hotfix goes directly to `main`, immediately back-merge or cherry-pick the same fix into `staging` so environments do not drift.

## Agent Guardrails

- Never push directly to `main` or `staging`.
- Never merge a pull request unless the owner explicitly authorizes it in the current task.
- Never create a production PR while the worktree has unrelated dirty files.
- Never include unrelated dependency or lockfile changes in a feature PR.
- Do not modify SQL, migrations, RLS, Supabase policies, Stripe, billing, or production environment settings outside the requested scope.
- If `staging` and `main` diverge, report ahead/behind counts and ask for sync approval before starting new feature work.
- If `staging` is behind `main` with no unique commits, recommend a staging sync before new work.

## Expected Final Report

Every implementation response must include:

1. Changed files.
2. Summary of behavior changes.
3. Target branch and intended PR base.
4. Validation commands and results.
5. Staging verification status or explicit reason it was not run.
6. Remaining risks.
7. Whether it is ready for PR, and whether that PR should target `staging` or `main`.

## Agent Harness Control Plane

The Agent Harness is a GitHub issue driven Planner -> Generator -> Evaluator -> Release Auditor workflow. It turns an owner goal into a bounded contract, implementation, validation report, and release-readiness audit.

### Branch Defaults

- `main` is the production release branch.
- `staging` is the pre-production integration branch.
- Agents must create implementation branches from the latest `origin/staging` by default.
- Agent pull requests must target `staging` by default.
- Production release work is always a separate owner-authorized gate.

### Harness Roles

- Planner: read-only. Converts the issue into a sprint contract with goal, allowed scope, forbidden actions, risk class, evidence requirements, and stop conditions.
- Generator: writes code and tests only inside the approved sprint contract.
- Evaluator: read-only. Verifies scope, diff, tests, evidence, and forbidden actions. It must not edit code.
- Release Auditor: read-only. Reviews release readiness, branch posture, checks, risk gates, and production relevance. It must not merge or deploy.
- Owner: defines business goals and production authorization. The owner does not act as the code reviewer.

Owner-facing reports must be in Chinese and must include a one-line decision summary and next action. Machine-readable fields must remain stable for automation.

### High-Risk Gate

High-risk tasks include billing, payments, auth, database schema, migrations, RLS, grants, production releases, real user data, environment or project settings, and high-risk issue closure.

High-risk tasks must have all of the following before they can advance:

1. A sprint contract.
2. Evaluator pass.
3. Release Auditor pass.
4. Explicit owner authorization for the next gate.

Production is never bundled into an implementation PR. Production deployment, production smoke, and production merge are always separate owner release gates.

### Permanent Forbidden Actions

Agents must not perform these actions unless a future owner-approved gate explicitly authorizes a narrower manual procedure:

- Production deployment or production smoke.
- Supabase production database access.
- Stripe live actions.
- Real checkout, payment, refund, cancel, or webhook replay.
- Vercel, Supabase, or Stripe environment variable or project settings changes.
- Uncontrolled database migration.
- Uncontrolled RPC, RLS, schema, or grant modification.
- Cron trigger.
- High-risk issue closure.
