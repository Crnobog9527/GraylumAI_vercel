# Admin Destructive Validation Checklist

Last reconciled: 2026-09-10

## Execution Rule

These flows must run only in an isolated preview or fixture-backed environment with:

1. Disposable or restorable seed data
2. Explicit `ENABLE_PARITY_DESTRUCTIVE_E2E=true` for the legacy parity destructive suite
3. Automated restoration for shared fixtures, or teardown of a disposable local environment

## Required Flow Pattern

Each destructive scenario must follow:

1. Build fixture
2. Execute destructive action
3. Verify changed state
4. Restore shared fixtures or tear down the disposable environment
5. Verify restoration/cleanup

## Disposable Admin Regression

From the repository root, with dependencies installed and Docker available:

```bash
node packages/db/tests/v3/run-workbench.mjs --admin-only
```

This runner creates isolated PostgreSQL, Auth, PostgREST and web fixtures. Its admin-only selection does not use the legacy parity flag. Do not substitute a staging or production database to benchmark deletion. See [admin operations](runbooks/ADMIN_OPERATIONS.md) for the request contract and recorded validation boundaries.

Covered batch removal cases: three fixtures deleted through one request, referenced-module conflict leaving the entire batch intact, anonymous/non-admin rejection, cancel without a write, replay with no further deletion, and acknowledged rows disappearing while list refresh is deliberately blocked. Cleanup removes the disposable environment; it does not recover deleted live records.

## Legacy Parity Checklist

| Flow | Route | Fixture required | Execute | Verify changed state | Rollback | Verify restored state | Current automation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Diagnostics cleanup | `/admin/diagnostics` | Existing old result rows | Cleanup old results | Row count/status changes | Re-seed not required if preview disposable | Dashboard remains usable after cleanup | `admin-destructive.spec.ts` |
| Expired conversation cleanup | `/admin/settings` | Expired conversation/history rows | Trigger cleanup | Cleanup status + row count changes | Re-seed fixture | History counts recover | `admin-destructive.spec.ts` |
| Model disable/restore | `/admin/models` + `/chat` | At least one active model | Toggle inactive | User model selector/runtime reflects removal | Re-enable model | User model selector/runtime reflects restoration | `admin-destructive.spec.ts` |
| Announcement publish/unpublish | `/admin/announcements` + user surfaces | Fixture announcement | Toggle active/publish state | Banner/homepage visibility changes | Restore original active state | User surface returns to baseline | `admin-destructive.spec.ts` |
| Credit package publish/unpublish | `/admin/packages` + `/profile` | Fixture package | Toggle active | User subscription page visibility changes | Restore active state | User subscription page returns to baseline | `admin-destructive.spec.ts` |
| Membership plan disable/restore | `/admin/packages` + `/profile` | Fixture membership plan | Toggle active | User subscription page visibility changes | Restore active state | User subscription page returns to baseline | `admin-destructive.spec.ts` |
| User role promote/restore | `/admin/users` + `/admin` | Dedicated test user | Change role | Admin access granted | Restore role | Admin access removed | `admin-destructive.spec.ts` |
| User status disable/restore | `/admin/users` + auth/user surfaces | Dedicated test user | Disable/ban | User blocked or downgraded appropriately | Restore status | User access restored | `admin-destructive.spec.ts` |
| System prompt switch/restore | `/admin/prompts` + AI runtime | Prompt fixtures + live runtime | Toggle active prompt | Costs/runtime proof shows changed prompt usage | Restore prior prompt | Runtime returns to baseline prompt | `admin-destructive.spec.ts` |

## Acceptance Notes

- A gated destructive test does not count toward default acceptance.
- Destructive coverage becomes part of release acceptance only when the environment can guarantee rollback safety.
- Use disposable fixtures for irreversible deletion; never treat a successful test as authorization to delete shared or production records.
