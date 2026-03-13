# Phase 4 Security and RLS Audit

Last updated: 2026-03-12

## Scope

This audit covers local, non-payment security checks that can be validated without relying on live provider behavior:

- admin page and admin tRPC authorization boundaries
- user data isolation for profile, tickets, credits, conversations, and history paths
- RLS posture for core tables
- high-risk rendering and upload surfaces

This is a code-and-policy audit, not a hosted penetration test.

Hosted runtime acceptance for the deployed Vercel preview is tracked separately from this audit and is now green for the preview-only diagnostics runtime-proof flow.

## Supabase Security Advisor Status

The repo-backed Security Advisor findings shown in Supabase have now been addressed in
[`packages/db/migrations/0015_security_advisor_hardening.sql`](../packages/db/migrations/0015_security_advisor_hardening.sql)
and that migration has been applied to the hosted Supabase database.

This hardening batch covers:

- enabling RLS on `conversation_context_snapshots`
- converting `diagnostic_latest_results` to `security_invoker = true`
- removing blanket-true service policies that widened advisor surface unnecessarily
- setting an explicit `search_path = public, pg_temp` on the repo-tracked `SECURITY DEFINER` functions used by billing, diagnostics, logs, and maintenance flows

Two important follow-ups remain outside the repo migration itself:

1. `Leaked Password Protection Disabled` must be enabled manually in Supabase Auth settings.
2. Any Security Advisor warnings that still reference objects not present in this repo's migrations should be treated as live-database drift and cleaned up directly in the database or brought back into versioned migrations first.

The first hosted drift cleanup batch has also now been applied through
[`packages/db/migrations/0016_live_db_drift_security_cleanup.sql`](../packages/db/migrations/0016_live_db_drift_security_cleanup.sql),
which removes stale blanket INSERT policies on `invitation_records` and `user_activity_logs`
and locks `search_path` on the legacy hosted functions `deduct_credits_atomic()` and
`update_updated_at_column()`.

## Regression Evidence Added In This Batch

- `apps/web/tests/e2e/security.spec.ts` now verifies that representative non-admin admin write procedures are rejected.
- `apps/web/tests/e2e/security.spec.ts` now verifies self-only access for cross-user ticket and conversation reads.
- `apps/web/tests/e2e/security.spec.ts` now keeps the streamed markdown link-sanitization regression in place.
- `apps/web/tests/e2e/security.spec.ts` now verifies ticket uploads return private storage paths and authorized readers receive signed URLs instead of public object URLs.
- `apps/web/tests/e2e/security.spec.ts` now verifies that a non-owner cannot obtain a signed attachment URL by reading another user's ticket through the ordinary user router.
- `apps/web/src/app/api/ai/stream/route.ts` now uses a user-scoped Supabase auth client for ordinary user profile, conversation, message-history, free-tier usage, and context-snapshot operations instead of defaulting those paths to the service-role client.

## Verification Basis

- `packages/api/src/trpc.ts`
- `packages/api/src/lib/ticketAttachments.ts`
- `packages/api/src/routers/admin.ts`
- `packages/api/src/routers/diagnostics.ts`
- `packages/api/src/routers/settings.ts`
- `packages/api/src/routers/chat.ts`
- `packages/api/src/routers/ticket.ts`
- `packages/api/src/routers/user.ts`
- `packages/api/src/routers/credits.ts`
- `packages/api/src/routers/invitation.ts`
- `packages/api/src/routers/checkin.ts`
- `apps/web/src/app/api/upload/route.ts`
- `apps/web/src/components/ai/MessageStream.tsx`
- `apps/web/src/components/layout/GlobalBanner.tsx`
- `packages/db/migrations/0001_ai_billing_tables.sql`
- `packages/db/migrations/0002_enable_rls_all_tables.sql`
- `packages/db/migrations/0013_checkin_rewards.sql`

## Executive Summary

- Admin write/read surfaces reviewed in this audit are protected by `adminProcedure`.
- User-facing data paths reviewed in this audit are scoped in application code to `ctx.profileId`.
- Core tables do have RLS policies, and the server-side tRPC layer now separates user-scoped access from privileged admin/maintenance/webhook access.
- One real XSS risk was present in streamed message rendering and is now fixed.
- Ticket attachment delivery is now private-path based and authorized readers receive short-lived signed URLs.
- Representative local security regressions now exist for non-admin admin writes, self-only user access, and streamed markdown sanitization.
- The Next.js tRPC route now forwards the cookie-scoped Supabase auth client into `createTRPCContext`, closing the fallback where ordinary user requests could arrive with a known `user` but still lose `supabaseAuth`.
- The non-tRPC AI streaming route now follows the same split-client model: ordinary user-owned reads and writes run through `supabaseAuth`, while billing finalization and controlled system reads remain on `supabaseAdmin`.

## Findings

| Risk | Finding | Location | Impact | Status |
| --- | --- | --- | --- | --- |
| P1 | Server-side tRPC commonly uses a service-role Supabase client, so RLS is not the primary enforcement layer for server requests | `packages/api/src/trpc.ts` | If an app-layer authorization check regresses, RLS may not stop the server-side query path | Resolved |
| P1 | The non-tRPC AI streaming route previously defaulted ordinary user-owned reads and writes to a service-role Supabase client | `apps/web/src/app/api/ai/stream/route.ts` | User profile, conversation, history, and snapshot operations were bypassing the user-scoped auth client despite already having a verified bearer token | Resolved |
| P1 | Ticket attachments are stored in a public bucket and returned as public URLs | `apps/web/src/app/api/upload/route.ts` | Any leaked attachment URL is directly retrievable without per-ticket authorization | Resolved |
| P1 | Streamed markdown rendering previously allowed unescaped HTML construction before `dangerouslySetInnerHTML` | `apps/web/src/components/ai/MessageStream.tsx` | XSS risk on AI/user message content | Resolved |
| P2 | `admin/tickets` previously used `icon.innerHTML` for attachment fallback rendering | `apps/web/src/app/admin/tickets/page.tsx` | DOM string mutation pattern in an otherwise React-controlled surface | Resolved |
| P2 | Hosted Supabase Security Advisor reported exposed runtime snapshots, definer-view behavior, and mutable search_path on definer functions | `packages/db/migrations/0015_security_advisor_hardening.sql` | Database-side policy drift weakened the hosted security posture beyond app-layer controls | Resolved |

## Admin Boundary Review

### Verified controls

- `protectedProcedure` requires an authenticated, email-verified user.
- `adminProcedure` extends `protectedProcedure` and rejects any non-admin role.
- Reviewed admin routers and write surfaces are gated by `adminProcedure`, including:
  - diagnostics
  - admin user management
  - admin ticket handling
  - model management
  - settings updates
  - costs and finance-oriented admin reads
  - invitation administration

### Regression-tested in this batch

- `settings.updateSystemSettings` is rejected for an authenticated non-admin user.
- `admin.updateUserStatus` is rejected for an authenticated non-admin user.
- Representative cross-user reads through `chat.getMessages` and `ticket.getTicketById` are denied for ordinary users.

### Residual architecture note

`createTRPCContext()` now creates two explicit database clients:

- `supabaseAuth` for user-token / RLS-aligned access
- `supabaseAdmin` for privileged admin, maintenance, webhook, and controlled server tasks

This means:

1. Protected user procedures now prefer `supabaseAuth` for self-scoped profile and business reads.
2. `adminProcedure` explicitly switches back to `supabaseAdmin` for privileged flows.
3. Existing RLS policies remain defense in depth, but the project no longer defaults ordinary user business routes to the service-role client.
4. The App Router tRPC handler now preserves the cookie-scoped auth client, so browser requests authenticated via Supabase session cookies stay on the user-scoped path even when `user` is pre-hydrated before context creation.
5. The App Router AI streaming route now mirrors that split: user-owned business reads/writes use `supabaseAuth`, while the billing service and other controlled privileged operations remain on `supabaseAdmin`.

## User Data Isolation Review

### Access matrix

| Surface | Anonymous | Authenticated self | Cross-user access attempt | Admin |
| --- | --- | --- | --- | --- |
| Profile | blocked by `protectedProcedure` | scoped to `ctx.profileId` | not exposed via reviewed user routers | separate admin routers exist |
| Conversations / messages / exports | blocked by `protectedProcedure` | scoped to `user_id = ctx.profileId` and conversation ownership checks | denied by ownership filters in chat router | separate admin access paths |
| Credits / usage summary | blocked by `protectedProcedure` | scoped to `user_id = ctx.profileId` | denied by ownership filters in credits router | separate admin finance/cost views |
| Tickets / replies | blocked by `protectedProcedure` | scoped to `user_id = ctx.profileId` | denied by ticket ownership filters | admin ticket management exists |
| Check-in / invitation dashboard | blocked by `protectedProcedure` except public invitation claim flow | scoped to current user for dashboard/history/status | not exposed in reviewed user routes | admin invitation oversight exists |

### Verified implementation pattern

The reviewed user routers consistently scope reads and writes using the current profile identity, for example:

- conversations filtered by `user_id = ctx.profileId`
- ticket queries filtered by `user_id = ctx.profileId`
- credit transactions and summaries filtered by `user_id = ctx.profileId`
- user profile and usage stats keyed to `ctx.profileId`

No reviewed user route intentionally exposes arbitrary user identifiers as query inputs for direct cross-user reads.

## RLS Review

### Verified policy coverage

The migration set shows RLS enabled for key tables including:

- `profiles`
- `conversations`
- `messages`
- `credit_transactions`
- `tickets`
- `ticket_replies`
- `system_settings`
- `announcements`
- `membership_plans`
- `invitations`
- `invitation_records`

Additional later migrations extend the model for AI billing and check-in flows.

### Audit conclusion

- RLS is present on core business tables.
- The policy set is materially better than having no database isolation.
- RLS remains defense in depth for server-originated access, but the highest-volume ordinary user paths now go through a user-scoped client rather than default service-role access.

## High-Risk Surface Review

### Streamed markdown rendering

Reviewed file: `apps/web/src/components/ai/MessageStream.tsx`

Result:

- Fixed in this phase.
- The renderer now escapes ordinary text before markdown transforms.
- Code blocks and inline code are placeholder-protected and escaped.
- Links are sanitized to allow only:
  - relative `/`
  - fragment `#`
  - `http:`
  - `https:`
  - `mailto:`

Security outcome:

- The previous HTML injection path into `dangerouslySetInnerHTML` is closed for the reviewed renderer.
- Regression coverage now explicitly checks `javascript:` link sanitization through the extracted markdown helper path.

### Announcement / banner rendering

Reviewed file: `apps/web/src/components/layout/GlobalBanner.tsx`

Result:

- No `dangerouslySetInnerHTML`
- banner title and description are rendered as text
- external links use `rel="noopener noreferrer"`

Security outcome:

- No direct XSS sink identified in the reviewed global banner path.

### File upload path

Reviewed file: `apps/web/src/app/api/upload/route.ts`

Verified controls:

- bearer token required
- token user is resolved before upload
- image MIME types only
- 5 MB size limit

Current model:

- the bucket is created with `public: false`
- the upload API returns only a storage path
- ticket read surfaces exchange storage paths for short-lived signed URLs only after ticket ownership or admin authorization checks

Security outcome:

- upload authentication and file-type/size gating are present
- attachment retrieval is no longer public by default and now depends on authorized signed access

### Invitation and check-in runtime

Reviewed files:

- `packages/api/src/routers/invitation.ts`
- `packages/api/src/routers/checkin.ts`

Result:

- user dashboards and status routes are protected
- admin analytics/update routes are on `adminProcedure`
- `claimInvitationCode` is intentionally public for signup

Security outcome:

- no obvious missing auth boundary found in the reviewed invitation/check-in routers

## Required Follow-Ups

### Priority 1

1. Keep any future non-tRPC user-facing routes aligned to the same split-client rule so newly added ordinary user read/write paths do not regress back to service-role defaults.
2. If attachment lifetime needs to be shortened further, consider a dedicated authorized download route in place of signed URLs.

## Exit Criteria

This audit can be considered closed when:

1. The server-side authorization model is explicitly documented as either:
   - app-layer primary + RLS secondary, or
   - migrated toward user-token-enforced queries for sensitive reads
2. Ticket attachments are no longer publicly retrievable by stable URL alone.
3. The `MessageStream` XSS fix remains covered by regression checks.
