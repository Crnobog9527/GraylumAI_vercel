# Sprint Contract Schema

Sprint contract 可以用 JSON 或 Markdown 表达，但必须包含下列字段。Markdown contract 应使用相同字段名作为小标题或表格键。

## JSON Shape

```json
{
  "contract_version": "1.0",
  "issue": {
    "number": 0,
    "url": "",
    "title": ""
  },
  "owner_goal": "",
  "business_context": "",
  "non_goals": [],
  "risk_class": {
    "billing": false,
    "stripe": false,
    "supabase": false,
    "cron": false,
    "migration": false,
    "production": false
  },
  "branches": {
    "base": "origin/staging",
    "pr_target": "staging",
    "production_target": "main"
  },
  "allowed_scope": {
    "files": [],
    "modules": [],
    "operations": []
  },
  "forbidden_actions": [],
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "description": "",
      "evidence_required": ""
    }
  ],
  "implementation_notes": [],
  "test_plan": [
    {
      "command_or_check": "",
      "environment": "local",
      "required": true
    }
  ],
  "evaluator_requirements": {
    "ci_required": true,
    "security_required": true,
    "playwright": "not_required",
    "api": "not_required",
    "supabase": "not_required",
    "stripe": "not_required"
  },
  "rollback_plan": "",
  "stop_conditions": [],
  "handoff": {
    "generator": "",
    "evaluator": "",
    "release_auditor": ""
  }
}
```

## Required Field Semantics

- `contract_version`: schema version, currently `1.0`.
- `issue`: GitHub issue identity. Must include at least number or URL.
- `owner_goal`: plain-language business outcome.
- `business_context`: why the work matters.
- `non_goals`: explicit exclusions so Generator does not expand scope.
- `risk_class`: high-risk flags. Any true value requires stricter evidence.
- `branches.base`: default `origin/staging`.
- `branches.pr_target`: default `staging`.
- `branches.production_target`: default `main`, release gate only.
- `allowed_scope`: exact files, modules, or operations Generator may touch.
- `forbidden_actions`: actions no agent may perform for this sprint.
- `acceptance_criteria`: testable pass/fail requirements.
- `implementation_notes`: constraints, local patterns, or preferred approach.
- `test_plan`: commands or checks Generator should run before handoff.
- `evaluator_requirements`: evidence Evaluator must collect.
- `rollback_plan`: how to undo the change if staging fails.
- `stop_conditions`: conditions that require the agent to stop and report.
- `handoff`: short instructions for Generator, Evaluator, and Release Auditor.

## Markdown Minimum

If Markdown is used instead of JSON, include:

- `Issue`
- `Owner Goal`
- `Non-goals`
- `Risk Class`
- `Base Branch`
- `PR Target`
- `Allowed Scope`
- `Forbidden Actions`
- `Acceptance Criteria`
- `Test Plan`
- `Evaluator Requirements`
- `Rollback Plan`
- `Stop Conditions`
- `Handoff`
