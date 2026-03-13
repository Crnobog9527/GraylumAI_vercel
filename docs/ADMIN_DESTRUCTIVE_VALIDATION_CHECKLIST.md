# Admin Destructive Validation Checklist

Last updated: 2026-03-10

## Execution Rule

These flows must run only in an isolated preview or fixture-backed environment with:

1. Disposable or restorable seed data
2. Explicit `ENABLE_PARITY_DESTRUCTIVE_E2E=true`
3. Automated rollback in the same test

## Required Flow Pattern

Each destructive scenario must follow:

1. Build fixture
2. Execute destructive action
3. Verify changed state
4. Roll back to original state
5. Verify restored state

## Checklist

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
- Any destructive admin operation without a rollback path must remain blocked from shared acceptance environments.
