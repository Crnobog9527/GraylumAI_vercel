# Release Auditor Report Schema

The Release Auditor report is independent release-gate evidence produced under `AUDITED_STATE_READ_ONLY`. It does not merge, deploy, or authorize production by itself. The sole write exception is `REPORT_COMMENT_PERSISTENCE_EXCEPTION`: after a completed canonical audit, the Release Auditor may append exactly one top-level PR Conversation comment containing the complete canonical structured report for that run only when the Owner authorization for that exact audit explicitly includes report persistence. Generic audit wording, `read-only`, or silence does not authorize the comment.

`REPORT_COMMENT_IS_EVIDENCE_ONLY`: the persisted comment is evidence only and never authorizes remediation, mark-ready, merge, deploy, production, Issue lifecycle mutation, a next gate, or Owner authorization. It is not a review submission and does not permit `APPROVE`, `REQUEST_CHANGES`, inline review comments, PR metadata mutation, comment editing/deletion, code/repository mutation, branch/commit writes, merge, deployment, or external-system mutation.

## Required Fields

```yaml
report_role: RELEASE_AUDITOR
report_id: string
machine_decision: PASS | FAIL | BLOCKED
owner_summary_zh: string
owner_next_action_zh: string
risk_level: low | medium | high | production
can_merge_to_staging: boolean
can_release_to_production: boolean
forbidden_actions_observed: boolean
required_human_authorization: none | owner | production_owner_gate
evidence_links:
  github_checks:
    - string
  pull_request: string
  issue: string
  logs:
    - string
  reports:
    - string
stop_reason: string | null
issue:
  number: integer
  url: string
pull_request:
  number: integer
  url: string
  base_branch: string
  base_sha: string | null
  head_branch: string
  head_sha: string
  mergeable: boolean
contract:
  path: string
evaluator:
  report_path: string
  result: pass | pass-with-notes | blocked | fail
result: ready-for-owner-audit | blocked | not-applicable
branch_posture:
  base_current: boolean
  target_branch: string
  production_branch_touched: boolean
checks:
  ci: pass | fail | pending | not-run
  security: pass | fail | pending | not-run
  required_validation:
    - command: string
      result: pass | fail | not-run
forbidden_actions:
  status: pass | blocked | fail
  evidence:
    - string
production_relevance:
  status: none | possible | direct
  owner_release_gate_required: boolean
owner_decision_needed: string
```

## Persistence Binding

A persisted canonical Release Auditor report comment must contain this entire schema, must have explicit Owner authorization for persistence for that run, and must bind the exact audited PR number, exact audited `head_sha`, `base_branch`, and exact non-null `base_sha` for `machine_decision: PASS`. A `BLOCKED` report may use `base_sha: null` only when inability to determine the base is itself the blocking condition. `report_role`, `report_id`, and `machine_decision` are mandatory in the persisted comment.

If persistence is not explicitly authorized, do not post. If the exact PR identity or audited head cannot be verified, or the canonical report is incomplete, do not post. If exact base SHA cannot be determined, `PASS` is forbidden and `machine_decision` must be `BLOCKED`. Do not replace a missing report comment with another GitHub mutation.

## Owner and Automation Fields

All Release Auditor reports must include stable machine-readable fields and Chinese owner-facing fields.

- `machine_decision` is the automation-safe result. Use `PASS` only when the PR is ready for the requested non-production gate and binds a non-null exact base SHA plus exact audited head SHA. Use `FAIL` for contract, check, or forbidden-action failures. Use `BLOCKED` when owner authorization, missing evidence, missing exact base/head identity, or a separate remediation track is required.
- `owner_summary_zh` must be a one-sentence Chinese conclusion.
- `owner_next_action_zh` must tell the owner the single next action needed now.
- `can_merge_to_staging` and `can_release_to_production` must be explicit booleans.
- `required_human_authorization` must be `production_owner_gate` for production release decisions.
- `stop_reason` is required when `machine_decision` is `BLOCKED`.

## Rules

- `ready-for-owner-audit` is not merge authorization.
- Production is always a separate owner release gate.
- If Evaluator is blocked or fail, Release Auditor must be blocked.
- If forbidden actions were performed, Release Auditor must fail.
- A Release Auditor `PASS` requires `pull_request.base_sha` to be a non-null exact SHA bound to the audited base. If exact base SHA is unavailable, return `BLOCKED`.
- Report persistence never changes any of those decision semantics or gates.