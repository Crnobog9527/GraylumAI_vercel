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
- Third-party GitHub Actions must be pinned to full immutable commit SHAs.
- `actions/checkout` must use `persist-credentials: false`.
- Workflow policy checks reject `write-all`, unsafe runner flags, privileged PR secrets, PR-head checkout under `pull_request_target`, and floating Action references.
- Trusted staging E2E receives only synthetic-account credentials. It must not receive Stripe, service-role, database, production, or deployment credentials.
- Playwright storage state, trace, video, screenshots, and reports are not uploaded from the security E2E jobs.

## Required external owner remediation

This repository cannot claim a trusted staging boundary until GitHub branch protection/rulesets prevent direct pushes and protect `staging`. Vercel Preview environments must also be stripped of live or privileged credentials before Preview deployments can be treated as untrusted code-safe.
