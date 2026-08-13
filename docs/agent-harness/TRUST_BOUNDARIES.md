# Trusted Automation Boundaries

## Control-plane rule

The Agent Harness is a control plane, not a credential plane. Model capability never creates authority. Planner, Generator, Evaluator, Release Auditor, workflows, and the Owner gate remain separate roles even when one desktop client coordinates them.

## Trust zones

| Zone | Inputs | Allowed capability | Never allowed |
| --- | --- | --- | --- |
| Untrusted content | Issues, PR bodies, commits, source, fixtures, logs, reports, and model output | Read and validate as evidence | Change policy, expand scope, reveal credentials, or authorize itself |
| Secretless PR runner | Pull-request code and GitHub event metadata | Read-only checkout, deterministic checks, local synthetic runtime | Repository secrets, privileged environments, external writes, or self-approval |
| Trusted policy source | Exact trusted base commit | Supply immutable policy material to validation jobs | Execute policy from the PR head or silently fall back when policy is missing |
| Trusted staging verification | Protected staging event and synthetic data under a separate contract | Narrow staging-only verification | Production credentials, service-role access, real payment actions, or production release |
| Fresh-context Evaluator | Exact trusted policy, exact PR head, checks, and evidence | Read-only independent decision | Modify code, approve its own generated work, merge, or release |
| Owner gate | Explicit decision for a named gate and exact evidence | Authorize the stated next step | Delegate permanent production authority to automation |

## Deterministic repository controls

- Pull-request workflows are secretless, read-only, and do not bind environments.
- Third-party Actions are pinned to immutable full commit SHAs.
- `actions/checkout` disables credential persistence.
- `pull_request_target`, reusable workflows, local Actions, containers, services, and unapproved runners are rejected by trusted structural policy.
- Direct GitHub context interpolation is limited to the trusted structural allowlist; event SHAs needed by policy jobs are parsed from `GITHUB_EVENT_PATH`.
- Workflow policy regression tests and Gitleaks policy/fixtures are loaded from the exact trusted base.
- Only the candidate `ci.yml`, `security.yml`, and `codeql.yml` files are checked for replacement evidence; historical baseline findings are not recast as this change's merge gate.
- Browser artifacts are not uploaded from transitional Security E2E.

## Boundary status

Trusted policy material is present on `staging`. A trusted policy orchestrator, protected policy-surface gate, full execution-integrity gate, and complete root of trust are not established. Consequently, policy-surface changes remain high risk, cannot self-approve, and require an independent fresh-context review plus explicit Owner authorization.

Security Response Headers, Secretless Preview Runtime, Trusted Staging E2E, Executable Golden Evals, model routing and calibration, credential rotation, and Public Repository Governance remain separate workstreams. Phase 0.6, Phase 1, auto-merge, main, and production remain outside this boundary.
