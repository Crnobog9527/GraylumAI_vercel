# Logging Exception Review

## Scope

This review was run after the logging-governance cleanup across:

- `apps/web/src`
- `packages/api/src`

Supplementary repo-wide scans also checked for remaining runtime-style `console.error/warn/info`
outside tests, docs, build output, and `node_modules`.

## Result

### Runtime App Code

There are no remaining direct `console.error/warn/info` calls in business/runtime code under:

- `apps/web/src`
- `packages/api/src`

The only intentional logging entry point left in `apps/web/src` is:

- `apps/web/src/lib/client-log.ts`

This file is the approved client-side dev-only logging wrapper and is expected to call
`console.warn/error` internally.

Related approved runtime logging adapters now include:

- `apps/web/src/lib/client-log.ts`
- `apps/web/src/lib/server-log.ts`
- `packages/api/src/lib/logger.ts`

These are considered framework/logging infrastructure, not stray business logs.

## Remaining Exceptions Outside Runtime Scope

The following files still contain direct `console` usage, but they are currently outside the
main runtime-governance scope because they are scripts, local tooling, test fixtures, or
documentation snippets.

### Scripts / Local Tooling

No remaining direct runtime-style `console.error/warn/info` findings after cleanup.

### Test Support

- `apps/web/tests/e2e/support/creditFixtures.ts`

### Documentation / Generated Notes

- `AI_REFACTOR_DESIGN_BRIEF.md`
- `progress.md`

## Recommendation

### Closed for Runtime Code

Logging cleanup for production runtime code can be treated as complete for:

- `apps/web/src`
- `packages/api/src`

### Optional Follow-up Batch

If we want a final repo-wide polish pass later, the next batch should target only:

1. test fixtures if we want stricter consistency
2. documentation snippets or generated progress notes
3. any future ad-hoc scripts before they are committed

That follow-up is cosmetic/consistency work, not a production logging-risk blocker.

## Verification Snapshot

Representative commands used during the review:

```bash
rg -n "console\\.(error|warn|info)\\(" apps/web/src packages/api/src
rg -n "console\\.(error|warn|info)\\(" . --glob '!**/node_modules/**' --glob '!**/.next/**' --glob '!**/dist/**' --glob '!**/coverage/**' --glob '!docs/**' --glob '!**/*.test.*' --glob '!**/__tests__/**'
```
