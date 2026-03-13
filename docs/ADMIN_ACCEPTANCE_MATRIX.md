# Admin Acceptance Matrix

Last updated: 2026-03-11

## Status Legend

- `verified`: Covered by automated acceptance and currently treated as passable
- `partial`: Some coverage exists, but at least one write path, effect path, or data proof is still missing
- `pending`: No meaningful end-to-end acceptance yet
- `gated`: Covered only by isolated destructive tests and not part of default acceptance

## Admin Page Matrix

| Page | Route | Main functions | Key data source(s) | Main write operations | Impacts user-facing surface | Existing coverage | Destructive | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard | `/admin` | Platform overview, KPI cards, diagnostics summary | `trpc.admin.getStatistics` | None | Indirect only | `admin.spec.ts` | No | `verified` |
| Users | `/admin/users` | Search, detail sheet, status, role, credits, membership | `trpc.admin.getAllUsers`, `getUserDetails` | `updateUserStatus`, `updateUserRole`, `adjustUserCredits`, `updateUserMembership` | Yes | `admin.spec.ts`, `admin-ops.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Models | `/admin/models` | Model CRUD, connection tests, active toggle | `trpc.model.getAvailableModels`, `getConnectionStatus` | `createModel`, `updateModel`, `deleteModel`, `testConnection` | Yes | `admin.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Prompts | `/admin/prompts` | Prompt module CRUD, active toggle | `trpc.admin.getAllPrompts`, `trpc.model.getActiveModels` | `createPrompt`, `updatePrompt`, `deletePrompt` | Yes | `admin-config.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Packages | `/admin/packages` | Credit package CRUD, membership plan CRUD, Stripe IDs | `trpc.admin.getAllPackages`, `getAllMembershipPlans` | `createPackage`, `updatePackage`, `deletePackage`, `createMembershipPlan`, `updateMembershipPlan`, `deleteMembershipPlan` | Yes | `admin-config.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Announcements | `/admin/announcements` | Banner/home announcements CRUD, active toggle | `trpc.admin.getAllAnnouncements` | `createAnnouncement`, `updateAnnouncement`, `deleteAnnouncement` | Yes | `admin-config.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Settings | `/admin/settings` | Global settings, feature flags, invite/check-in config, membership export policy, cleanup | `trpc.settings.getSystemSettings`, `trpc.admin.getAllMembershipPlans`, `trpc.admin.getCleanupStats` | `updateSystemSettings`, `updateMembershipPlan`, `cleanupExpiredConversations` | Yes | `admin-config.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Diagnostics | `/admin/diagnostics` | Runtime proof, test definitions, category runs, cleanup | `trpc.diagnostics.*` | `runAllTests`, `runCategoryTests`, `runSingleTest`, `cleanupOldResults` | Yes | `admin.spec.ts`, `admin-ops.spec.ts`, `admin-destructive.spec.ts` | Yes | `verified` |
| Tickets | `/admin/tickets` | Queue, detail sheet, reply, status updates | `trpc.admin.getAllTickets` | `updateTicketStatus`, `replyToTicket` | Yes | `admin-ops.spec.ts` | No | `verified` |
| Transactions | `/admin/transactions` | Billing records, filters, tabs | `trpc.admin.getAllTransactions`, `getAllUsers` | None | Indirect only | `admin-ops.spec.ts` | No | `verified` |
| Finance | `/admin/finance` | Finance/API statistics panels | `trpc.admin.getFinanceStats` | None | Indirect only | `admin-ops.spec.ts` | No | `verified` |
| Costs | `/admin/costs` | Usage logs, cost stats, charts | `trpc.costs.*` | None | Indirect only | `admin-ops.spec.ts`, runtime proof support flows | No | `verified` |
| Performance | `/admin/performance` | AI performance metrics, token distribution | `trpc.admin.getPerformanceStats` | None | Indirect only | `admin-ops.spec.ts` | No | `verified` |
| Invitations | `/admin/invitations` | Invite stats, risk records, search | `trpc.invitation.getInvitationStats`, `getAllInvitationRecords` | None | Indirect only | `admin-ops.spec.ts` | No | `verified` |

## Current Acceptance Gaps

1. Write-capable admin pages are now only treated as `verified` when their rollback path is covered by the isolated destructive suite.
2. High-value admin pages use section-level test ids for acceptance; remaining low-risk copy-driven locators are no longer blocking page verification.
3. A setting is only treated as complete when there is effect proof on the impacted user/runtime surface, not just persistence.
4. Preview-only AI runtime acceptance is now closed for real stream output, `route_upgraded`, stream abort, diagnostics runtime proof, and the deployed effect proofs for `enable_smart_routing` / `enable_smart_search_decision`.

## Ownership Notes

1. `/admin/settings` is the canonical owner for global settings and page-experience settings.
2. `/admin/announcements` is limited to announcement CRUD and active-state management.
3. `/admin/packages` owns membership plan lifecycle, while `/admin/settings` owns membership policy fields such as export and retention.
4. `transactions / finance / costs / performance / invitations` now have assertion-heavy read acceptance through `admin-ops.spec.ts`, not just shell coverage.

## Acceptance Rule

A page is only allowed to move from `partial` to `verified` when:

1. The page opens successfully.
2. At least one primary read path is asserted.
3. At least one primary write path is asserted if the page supports writes.
4. Any user-facing impact is proven from the affected user/admin/runtime surface.
5. If the action is destructive, rollback is automated and verified.
