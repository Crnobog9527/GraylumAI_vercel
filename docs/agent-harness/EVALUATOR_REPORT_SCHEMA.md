# Evaluator Report Schema

The Evaluator report is read-only evidence. It must not include patches or direct code changes.

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

## Result Meanings

- `pass`: The PR satisfies the contract and validation requirements.
- `pass-with-notes`: The PR can proceed but has non-blocking notes.
- `blocked`: The PR cannot proceed without external authorization, missing evidence, or a separate track.
- `fail`: The PR violates the contract or has failing required checks.
