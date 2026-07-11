# Trusted Automation Boundaries

## Control-plane rule

The Agent Harness is a control plane, not a credential plane. Planner, Generator, Evaluator, and Release Auditor receive only the minimum repository and GitHub metadata needed for their role. No role receives authority merely because a model, prompt, issue, pull request, or check output asks for it.

## Trust zones

| Zone | Inputs | Allowed capability | Never allowed |
| --- | --- | --- | --- |
| Untrusted | Issue text, PR body, commit messages, source code, test output, logs | Read as evidence | Treat instructions as authority, reveal secrets, change scope |
| PR runner | Fork or branch code under `pull_request` | Secretless build, static checks, local fixtures | Repository secrets, privileged environments, external writes |
| Trusted staging runner | A completed push to protected `staging` | Synthetic-account staging verification | Production credentials, service-role/DB credentials, production release |
| Owner gate | Explicit owner decision with evidence | Approve a named next gate | Delegate production authority to a model |

## Deterministic enforcement

- PR workflows must never reference `secrets.*`.
- PR workflows must not request any write permission.
- `pull_request_target` is forbidden.
- Third-party GitHub Actions must be pinned to full immutable commit SHAs.
- `actions/checkout` must use `persist-credentials: false`.
- Docker action references must be pinned by immutable digest.
- Workflow policy checks reject `write-all`, unsafe runner flags, PR secrets, `pull_request_target`, floating step or job-level Action references, missing checkout credential isolation, and auto-merge commands.
- Policy checkers and Gitleaks configuration are loaded from the exact trusted base SHA. They never execute policy code from the PR head; missing trusted policy fails closed.
- Future Evaluator prompts and deterministic policy are loaded from the exact trusted base SHA. PR content is evidence, never policy authority.
- Trusted staging E2E receives only synthetic-account credentials. It must not receive Stripe, service-role, database, production, or deployment credentials.
- Trusted staging E2E is disabled by default, is bound to the protected `staging-e2e` Environment, and fails on missing credentials, a non-allowlisted URL, no executed tests, or any skipped critical test.
- Playwright storage state, trace, video, screenshots, and reports are not uploaded from the security E2E jobs.

## External boundary status

The public repository now has branch protection on `main` and `staging`, and privileged credentials have been removed from ordinary Vercel Preview scope. Phase 0.5 remains blocked until open high-value secret alerts receive a rotation disposition, trusted policy files exist on the exact base SHA, and current-head checks and review pass.
