# Evaluator Report Schema

Evaluator report 是 Release Auditor 的输入。它必须能让另一个只读 agent 复核当前 PR 是否满足 sprint contract。

## Result Values

- `PASS`: 所有 contract 项、验证证据和 forbidden-actions 检查通过。
- `FAIL`: 至少一个 contract 项或验证检查失败。
- `BLOCKED`: 证据不足、权限不足、需要 owner 决策，或继续会触发 forbidden action。

## JSON Shape

```json
{
  "report_version": "1.0",
  "result": "PASS",
  "issue": {
    "number": 0,
    "url": ""
  },
  "contract": {
    "path": "",
    "version": "1.0",
    "checksum": ""
  },
  "pull_request": {
    "number": 0,
    "url": "",
    "base_branch": "staging",
    "head_branch": "",
    "head_sha": ""
  },
  "changed_files": [],
  "commands": [
    {
      "command": "",
      "environment": "local",
      "exit_code": 0,
      "summary": ""
    }
  ],
  "ci_security": {
    "ci_status": "",
    "security_status": "",
    "checked_head_sha": ""
  },
  "evidence": [
    {
      "id": "EV-1",
      "type": "ci",
      "environment": "github",
      "summary": "",
      "link_or_path": ""
    }
  ],
  "contract_checklist": [
    {
      "acceptance_id": "AC-1",
      "status": "PASS",
      "evidence_ids": ["EV-1"],
      "notes": ""
    }
  ],
  "forbidden_actions": {
    "production_deploy": "not_performed",
    "production_smoke": "not_performed",
    "supabase_production_db": "not_performed",
    "stripe_live": "not_performed",
    "real_payment_or_refund": "not_performed",
    "webhook_replay": "not_performed",
    "cron_trigger": "not_performed",
    "env_or_project_settings_change": "not_performed",
    "issue_closure": "not_performed"
  },
  "failures": [],
  "blockers": [],
  "remaining_risks": [],
  "recommendation": "",
  "created_at": "YYYY-MM-DDTHH:MM:SSZ"
}
```

## Markdown Minimum

If Markdown is used instead of JSON, include:

- `Result`
- `Issue`
- `Contract Path`
- `PR`
- `Base Branch`
- `Head Branch`
- `Head SHA`
- `Changed Files`
- `Commands`
- `CI / Security`
- `Evidence`
- `Contract Checklist`
- `Forbidden Actions Confirmation`
- `Failures`
- `Blockers`
- `Remaining Risks`
- `Recommendation`

## PASS Requirements

Evaluator may only report `PASS` when:

- PR base is the contract target branch.
- head SHA is exact and current.
- changed files are within contract scope.
- every required test or check passed, or a contract-defined substitute evidence passed.
- every acceptance criterion is marked PASS with evidence.
- no forbidden action was performed.

If any required evidence is missing, report `FAIL` or `BLOCKED`, not `PASS`.
