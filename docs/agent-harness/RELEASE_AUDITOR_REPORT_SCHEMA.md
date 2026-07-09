# Release Auditor Report Schema

The Release Auditor report is a read-only release gate artifact. It does not merge, deploy, or authorize production by itself.

## Required Fields

```yaml
report_id: string
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

## Rules

- `ready-for-owner-audit` is not merge authorization.
- Production is always a separate owner release gate.
- If Evaluator is blocked or fail, Release Auditor must be blocked.
- If forbidden actions were performed, Release Auditor must fail.
