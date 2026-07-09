# Sprint Contract Schema

The sprint contract is the Planner output. It must be reviewed before Generator work starts.

## Required Fields

```yaml
contract_id: string
issue:
  number: integer
  url: string
  title: string
owner_goal: string
risk_class: low | medium | high | production
base_branch: string
target_branch: string
allowed_scope:
  files:
    - string
  commands:
    - string
  services:
    - string
forbidden_actions:
  - string
implementation_plan:
  - string
required_validation:
  - command: string
    purpose: string
    required: boolean
evaluator_checklist:
  - string
release_auditor_checklist:
  - string
production_relevance:
  status: none | possible | direct
  owner_gate_required: boolean
stop_conditions:
  - string
```

## Rules

- `base_branch` defaults to `origin/staging`.
- `target_branch` defaults to `staging`.
- High-risk contracts must require Evaluator pass, Release Auditor pass, and explicit owner authorization before the next gate.
- Production work must be represented as a separate owner release gate.
- The contract must list forbidden actions directly instead of referring to another document only by name.
