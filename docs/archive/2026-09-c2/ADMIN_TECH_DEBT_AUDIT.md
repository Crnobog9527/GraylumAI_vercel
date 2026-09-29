# Admin Tech Debt Audit

Last updated: 2026-03-11

## Scope

Backend admin domain only:

- admin pages
- admin-oriented tRPC routers
- admin acceptance tests
- admin settings ownership and user/runtime effect links

## Findings

| Risk | Finding | Location | Root cause | Impact | Suggested action | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Page-setting ownership is split between announcements and settings | `apps/web/src/app/admin/announcements/page.tsx`, `apps/web/src/app/admin/settings/page.tsx` | Legacy migration left `chat_*` and `home_*` settings inside announcements while global settings live in settings | Duplicate entry points, ambiguous acceptance, higher maintenance cost | Move all system/page settings to `/admin/settings`; keep announcements page focused on announcement CRUD | Resolved |
| P1 | Default acceptance excludes destructive rollback flows | `apps/web/tests/e2e/admin-destructive.spec.ts` | Safety gate keeps high-risk tests out of shared runs | Release confidence gap for model/status/prompt/cleanup rollback paths | Preserve gate, but document isolated destructive suite as mandatory release-stage validation | Resolved |
| P1 | Read-only admin pages are only smoke-tested | `admin-ops.spec.ts`, `costs/page.tsx`, `finance/page.tsx`, `performance/page.tsx`, `transactions/page.tsx`, `invitations/page.tsx` | Existing parity work prioritized navigation/shell integrity over stronger assertions | Weak confidence in charts, filters, and data-to-UI correctness | Add stronger assertions for one primary dataset/filter per page | Resolved |
| P1 | Membership policy editing is split from membership plan lifecycle | `apps/web/src/app/admin/settings/page.tsx`, `apps/web/src/app/admin/packages/page.tsx` | Plan CRUD and policy fields are edited on separate pages | Operators must reason across pages to manage one concept | Keep split only if clearly documented; otherwise consider linking packages page to policy section | Resolved |
| P2 | Reference-only billing settings remain editable next to real billing controls | `apps/web/src/app/admin/settings/page.tsx` | Legacy token pricing config kept for compatibility after per-model billing moved | Operator confusion about which value is authoritative | Visually downgrade and document as reference-only, or remove after migration window | Resolved |
| P2 | Finance page still carries caution text about estimated token usage | `apps/web/src/app/admin/finance/page.tsx` | Historical behavior survived after token stats/runtime work improved | Documentation drift; may understate current runtime truth | Re-audit finance page copy against current token/accounting implementation | Resolved |
| P2 | Some admin acceptance logic depends on literal Chinese labels without section test ids | Multiple admin pages/tests | UI-first authoring without stable section locators | Flakier E2E maintenance when copy changes | Add section-level `data-testid` markers for high-value admin blocks | Resolved |

## Consolidation Principles

1. One concept, one owner page.
2. Settings are accepted only from the canonical owner page.
3. Read-only pages still need assertion-heavy checks, not just smoke coverage.
4. Gated destructive coverage is valid only with explicit rollback proof.
5. Split ownership is acceptable only when the page itself explains lifecycle ownership versus policy ownership.

## Exit Criteria

The admin-domain debt audit can be considered closed when:

1. `/admin/settings` is the single owner for non-announcement global/page settings.
2. Every admin page is represented in the acceptance matrix with a non-ambiguous status.
3. Every high-value setting has an effect proof or is explicitly marked as a gap.
4. Destructive flows have a documented isolated suite, rollback checklist, and a passing isolated execution record.
