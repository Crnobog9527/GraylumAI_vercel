# Evaluator Report Schema

The Evaluator report is read-only evidence. It must not include patches or direct code changes.

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
contract:
  path: string
  risk_class: low | medium | high | production
result: pass | pass-with-notes | blocked | fail
scope_review:
  status: pass | blocked | fail
  notes:
    - string
changed_files:
  allowed:
    - string
  out_of_scope:
    - string
validation:
  commands:
    - command: string
      result: pass | fail | not-run
      notes: string
forbidden_actions:
  status: pass | blocked | fail
  evidence:
    - string
risk_review:
  production_relevance: none | possible | direct
  owner_gate_required: boolean
recommendation: string
```

## Owner and Automation Fields

All Evaluator reports must include stable machine-readable fields and Chinese owner-facing fields.

- `machine_decision` is the automation-safe result. Use `PASS` only when the PR satisfies scope, validation, and forbidden-action checks. Use `FAIL` for contract violations or required-check failures. Use `BLOCKED` when external authorization, missing evidence, or a separate remediation track is required.
- `owner_summary_zh` must be a one-sentence Chinese conclusion.
- `owner_next_action_zh` must tell the owner the single next action needed now.
- `can_merge_to_staging` and `can_release_to_production` must be explicit booleans.
- `required_human_authorization` must be `production_owner_gate` for any production release relevance.
- `stop_reason` is required when `machine_decision` is `BLOCKED`.

## Result Meanings

- `pass`: The PR satisfies the contract and validation requirements.
- `pass-with-notes`: The PR can proceed but has non-blocking notes.
- `blocked`: The PR cannot proceed without external authorization, missing evidence, or a separate track.
- `fail`: The PR violates the contract or has failing required checks.
