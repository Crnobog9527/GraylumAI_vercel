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
- Trusted Staging E2E is a separate future workstream, not a workflow or exit criterion in PR #265. Its later contract must require synthetic accounts, a protected Environment, an allowlisted staging URL, and no production or privileged credentials.
- Playwright storage state, trace, video, screenshots, and reports are not uploaded from the security E2E jobs.

## Security Core boundary status

PR #265 establishes repository-side deterministic controls only. External GitHub/Vercel configuration, Trusted Staging E2E, executable Golden Evals, credential rotation, and public-repository governance remain independently tracked in Issue #263 and cannot expand or block the code scope of this PR.
