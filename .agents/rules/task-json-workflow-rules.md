---
trigger: always_on
---

# Task.json Driven Workflow Rules

Use `task.json`, `progress.md`, and `findings.md` together for any non-trivial development work in this repository.

## Single Source of Truth

- `task.json` is the only planning source.
- Task status is determined only by `passes`, `blocked`, `block_reason`, and `updated_at` in `task.json`.
- `progress.md` is for execution logs, validation notes, and blocking history.
- `findings.md` is for research findings, evidence, technical decisions, risks, and follow-up suggestions.
- `task_plan.md` is archived history only. Do not create new plans there and do not treat it as current truth.

## Natural Language Default

- If the user gives a new feature, bugfix, audit, or "continue" request in natural language, do not ask which file to update.
- First inspect `task.json`, `progress.md`, and `findings.md`.
- If the request is not represented in `task.json`, add 1-5 executable tasks automatically.
- Prefer task ordering by intent: verify, audit, fix, optimize.
- Every new task should include `id`, `step`, `title`, `description`, `priority`, `type`, `files`, `passes`, `blocked`, and `block_reason`.

## Execution Loop

- When continuing work, pick the best available task from `task.json` where `passes=false` and `blocked=false`.
- Sort by lowest `step`, then highest priority (`P0` > `P1` > `P2` > `P3`), then lowest `id`.
- Before substantial execution, re-read the relevant task entry plus the latest `progress.md` and `findings.md` context.

## Mandatory Sync Rules

- When starting a new task, update `progress.md` with the kickoff record and `findings.md` with key assumptions if they affect implementation.
- When research or code inspection produces a new conclusion, write it to `findings.md`.
- After every 2 research-style actions (search, grep, file inspection, browser/web reads), persist the new findings to `findings.md`.
- When a task is completed, update all three facts in the same work cycle:
  - `task.json` status
  - `progress.md` execution and validation record
  - `findings.md` key decision, evidence, or risk if anything non-obvious was learned

## Blocking Rules

- If a task is blocked, never mark it as passed.
- Set `blocked=true` and write a concrete `block_reason` in `task.json`.
- Record the blocking event, attempted work, and unblock condition in `progress.md`.
- Record the technical cause, evidence, and recommended next move in `findings.md`.

## User Experience Rules

- Assume the user should only need to describe intent in plain language.
- Do not ask the user to manually keep `task.json`, `progress.md`, or `findings.md` in sync.
- If the repo workflow and historical docs disagree, follow this rule file and treat older `task_plan.md` references as archival only.
