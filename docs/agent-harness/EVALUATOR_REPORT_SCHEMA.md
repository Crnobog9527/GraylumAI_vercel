# Evaluator Report Schema

The Evaluator report is independent evidence produced under `AUDITED_STATE_READ_ONLY`. It must not include patches or direct code/repository changes. The sole write exception is `REPORT_COMMENT_PERSISTENCE_EXCEPTION`: after a completed canonical audit, the Evaluator may append exactly one top-level PR Conversation comment containing the complete canonical structured report for that run only when the Owner authorization for that exact audit explicitly includes report persistence. Generic audit wording, `read-only`, or silence does not authorize the comment.

`REPORT_COMMENT_IS_EVIDENCE_ONLY`: the persisted comment is evidence only and never authorizes remediation, mark-ready, merge, deploy, production, Issue lifecycle mutation, a next gate, or Owner authorization. It is not a review submission and does not permit `APPROVE`, `REQUEST_CHANGES`, inline review comments, PR metadata mutation, comment editing/deletion, code/repository mutation, branch/commit writes, merge, deployment, or external-system mutation.

## Required Fields

```yaml
report_role: EVALUATOR
report_id: string
machine_decision: PASS | FAIL | BLOCKED
github_review_action: NONE
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

## Persistence Binding

A persisted canonical Evaluator report comment must contain this entire schema, must have explicit Owner authorization for persistence for that run, and must bind the exact audited PR number, exact audited `head_sha`, `base_branch`, and exact non-null `base_sha` for `machine_decision: PASS`. A `BLOCKED` report may use `base_sha: null` only when inability to determine the base is itself the blocking condition. `report_role`, `report_id`, and `machine_decision` are mandatory in the persisted comment.

If persistence is not explicitly authorized, do not post. If the exact PR identity or audited head cannot be verified, or the canonical report is incomplete, do not post. If exact base SHA cannot be determined, `PASS` is forbidden and `machine_decision` must be `BLOCKED`. Do not replace a missing report comment with another GitHub mutation.

## Owner and Automation Fields

All Evaluator reports must include stable machine-readable fields and Chinese owner-facing fields.

- `machine_decision` is the automation-safe result. Use `PASS` only when the PR satisfies scope, validation, forbidden-action checks, and binds a non-null exact base SHA plus exact audited head SHA. Use `FAIL` for contract violations or required-check failures. Use `BLOCKED` when external authorization, missing evidence, missing exact base/head identity, or a separate remediation track is required.
- `github_review_action` is always `NONE`; report persistence uses a top-level PR Conversation comment, not the GitHub review API.
- `owner_summary_zh` must be a one-sentence Chinese conclusion.
- `owner_next_action_zh` must tell the owner the single next action needed now.
- `can_merge_to_staging` and `can_release_to_production` must be explicit booleans.
- `required_human_authorization` must be `production_owner_gate` for any production release relevance.
- `stop_reason` is required when `machine_decision` is `BLOCKED`.

## Result Meanings

- `pass`: The PR satisfies the contract and validation requirements and binds exact non-null base/head identity.
- `pass-with-notes`: The PR can proceed but has non-blocking notes and still binds exact non-null base/head identity.
- `blocked`: The PR cannot proceed without external authorization, exact identity, missing evidence, or a separate track.
- `fail`: The PR violates the contract or has failing required checks.