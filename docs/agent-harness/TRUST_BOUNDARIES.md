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
| Fresh-context Evaluator / Release Auditor | Exact trusted policy, exact PR/base/head, checks, and evidence | `AUDITED_STATE_READ_ONLY` independent decision plus the sole explicitly Owner-authorized `REPORT_COMMENT_PERSISTENCE_EXCEPTION`: exactly one complete canonical top-level PR Conversation report comment after the audit | Modify code/repository files, branches, PR metadata, submit reviews, write inline review comments, edit/delete report comments, mutate issues, merge, deploy, release, or mutate external systems |
| Owner gate | Explicit decision for a named gate and exact evidence | Authorize the stated next step | Delegate permanent production authority to automation |

## REPORT_COMMENT_PERSISTENCE_EXCEPTION boundary

For canonical Evaluator and Release Auditor work, `read-only`, `strictly read-only`, and equivalent task wording mean `AUDITED_STATE_READ_ONLY`; they do not suppress a report-output write that the Owner explicitly authorized for that exact run, but they do not create that authorization. Generic audit wording or silence is not permission to write GitHub state.

The exception is available only when the Owner authorization for the exact audit explicitly includes report persistence, such as `persist/post the canonical report` or an unambiguously equivalent `persist_report: true` instruction. If persistence is not explicitly authorized, the audit returns its canonical report without any GitHub mutation.

The comment must contain the complete canonical structured report and bind exact PR number, exact audited head SHA, base branch, head branch, report role, `report_id`, and `machine_decision`. A `PASS` report must bind a non-null exact base SHA. If exact base SHA cannot be determined, the decision must be `BLOCKED`; a `BLOCKED` report may use `base_sha: null` only when missing base identity is the blocking condition.

`REPORT_COMMENT_IS_EVIDENCE_ONLY`. The comment cannot authorize remediation, mark-ready, merge, deploy, production, Issue lifecycle mutation, a later gate, or Owner authorization. It is not a GitHub review submission and does not broaden repository or external-system mutation authority.

Missing explicit persistence authorization, ambiguous PR identity, unverifiable audited head, missing exact base required for `PASS`, incomplete canonical output, or persistence failure fails closed. No alternate GitHub write is permitted as a substitute.

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

The narrow report-comment exception does not constitute self-approval: it exists only for an explicitly Owner-authorized persistence action, Evaluator and Release Auditor remain independent evidence-review roles, the comment is evidence only, and all later gate/merge/release decisions remain separately authorized.

Security Response Headers, Secretless Preview Runtime, Trusted Staging E2E, Executable Golden Evals, model routing and calibration, credential rotation, and Public Repository Governance remain separate workstreams. Phase 0.6, Phase 1, auto-merge, main, and production remain outside this boundary.