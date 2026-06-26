# Phase 0 Agent Harness Foundation Contract

## Issue

- Source: owner-authorized Codex task, no GitHub issue linked for this bootstrap PR.

## Owner Goal

Create the Phase 0 foundation for a GitHub issue driven Planner -> Generator -> Evaluator -> Release Auditor loop, without adding business functionality or automatic merge behavior.

## Non-goals

- Do not change business code.
- Do not add an auto-merge workflow.
- Do not add `.codex/hooks.json`.
- Do not run staging or production external service operations.
- Do not access production services, Stripe live, Supabase production, or Vercel/Supabase/Stripe settings.

## Risk Class

- billing: false
- Stripe: false
- Supabase: false
- cron: false
- migration: false
- production: false

## Base Branch

- `origin/staging`

## PR Target

- `staging`

## Allowed Scope

- `.github/workflows/ci.yml`
- `.github/workflows/security.yml`
- `AGENTS.md`
- `.github/codex/prompts/*.md`
- `.github/pull_request_template.md`
- `docs/agent-harness/*.md`

## Forbidden Actions

- production deploy or production smoke
- Supabase production DB access or write
- DB migration, RPC, RLS, schema, or grant write
- Stripe live action
- real checkout, payment, refund, cancel, or webhook replay
- Vercel, Supabase, or Stripe env / Project Settings change
- cron trigger
- merge
- issue closure
- Dependabot PR handling

## Acceptance Criteria

- CI and Security workflow PR triggers include `main` and `staging`.
- CI and Security workflow push triggers include `main` and `staging`.
- Existing `main` and `develop` PR coverage is preserved where it already existed.
- Agent rules document branch and production guardrails.
- Four Codex prompts exist for Planner, Generator, Evaluator, and Release Auditor.
- Agent Harness documentation defines labels, contract format, evaluator report format, staging auto-merge conditions, owner role, staging permissions, and production guardrails.
- Sprint contract and evaluator report schemas exist.
- PR template requires issue, contract path, base branch, head SHA, changed files, tests, evaluator result, release auditor result, and forbidden actions confirmation.
- No business code is changed.
- No auto-merge workflow or `.codex/hooks.json` is added.

## Test Plan

- `git diff --check`
- YAML parser check for `.github/workflows/ci.yml` and `.github/workflows/security.yml`
- Confirm `.codex/hooks.json` does not exist

## Evaluator Requirements

- Verify exact head SHA.
- Verify changed files match allowed scope.
- Verify no business code changes.
- Verify no forbidden actions occurred.
- Verify local static checks pass.
- Verify PR is draft and targets `staging`.

## Rollback Plan

Revert the Phase 0 documentation, prompt, PR template, and workflow-trigger commit from `staging`.

## Stop Conditions

- Any required change would touch business code.
- Any required validation needs production, Stripe live, Supabase production, Vercel/Supabase/Stripe settings, cron, or real payment actions.
- Any workflow change would introduce auto-merge behavior in Phase 0.
