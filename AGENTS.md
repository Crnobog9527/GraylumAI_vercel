# GraylumAI Agent Rules

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

## Agent Harness Automation Policy

The Agent Harness is a GitHub issue driven development loop:

1. Planner reads the issue and repository context, then produces a sprint contract.
2. Generator implements only the approved contract and writes or updates tests.
3. Evaluator verifies the contract with machine evidence and does not edit code.
4. Release Auditor checks branch, SHA, changed files, CI/Security, forbidden actions, and merge eligibility.

Branch rules for the harness:

- `main` is the production branch.
- `staging` is the pre-production integration branch.
- Agents default to creating branches from the latest `origin/staging`.
- Agent pull requests default to `staging`.
- `staging` may be used for automated development, testing, and repair after a contract and evaluator gate define the allowed scope.
- Promotion from `staging` to `main` is always a separate release gate and is never bundled into feature automation.

Permanent unattended-action guardrails:

- No unattended production deploy.
- No unattended production smoke test.
- No unattended Supabase production database access, write, migration, RPC, RLS, schema, or grant operation.
- No unattended Stripe live action, including checkout, payment, refund, cancel, or webhook replay.
- No unattended Vercel, Supabase, or Stripe environment variable or Project Settings modification.
- No unattended closure of high-risk issues.

High-risk task classes require a sprint contract and an evaluator pass before any staging merge is considered:

- billing
- Stripe
- Supabase
- cron
- migration

The owner is responsible for business goals and production release decisions. The owner is not expected to perform code review for Agent Harness PRs; machine gates and release-auditor evidence must carry that responsibility before staging automation proceeds.

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
