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
