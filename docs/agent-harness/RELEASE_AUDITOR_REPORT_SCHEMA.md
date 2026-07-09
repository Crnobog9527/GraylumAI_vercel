# Release Auditor Report Schema

The Release Auditor report is a read-only release gate artifact. It does not merge, deploy, or authorize production by itself.

## Required Fields

```yaml
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

## Owner and Automation Fields

All Release Auditor reports must include stable machine-readable fields and Chinese owner-facing fields.

- `machine_decision` is the automation-safe result. Use `PASS` only when the PR is ready for the requested non-production gate. Use `FAIL` for contract, check, or forbidden-action failures. Use `BLOCKED` when owner authorization, missing evidence, or a separate remediation track is required.
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
