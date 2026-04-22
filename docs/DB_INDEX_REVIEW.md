# Database Index Review

## Summary

This review focuses on the remaining admin and reporting paths that still perform frequent filtering or sorting on large tables. Existing coverage in [0007_performance_indexes.sql](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale Luminary LLC/Graylum_AI/GraylumAI_vercel/packages/db/migrations/0007_performance_indexes.sql) is solid for conversations, messages, credit transactions, tickets, and invitation basics, but admin-facing filters still leave several gaps.

The follow-up migration [0020_admin_query_indexes.sql](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale Luminary LLC/Graylum_AI/GraylumAI_vercel/packages/db/migrations/0020_admin_query_indexes.sql) adds the lowest-risk indexes that directly match current query patterns.

## Confirmed high-frequency query paths

- `profiles`
  - Admin user list sorts by `created_at` and filters by `status`, `membership_level`, and `role`
  - Admin dashboard aggregates recent users by `created_at`
- `tickets`
  - Admin ticket list filters by `status`, `category`, `priority` and sorts by `created_at`
- `credit_transactions`
  - Admin transactions filter by `user_id`, `type`, and date range on `created_at`
  - User detail and invitation flows aggregate user deductions/additions
- `prompts`
  - Admin prompt list filters by `category` and `active`, then sorts by `sort_order` and `created_at`
- `announcements`
  - Admin announcement list filters by `active` and sorts by `priority` then `created_at`
- `invitation_records`
  - Admin invitations page filters by `status`, `risk_level`, `search`, and sorts by `created_at`
  - Claim/risk checks filter by `ip_address` and recent `created_at`
- `ai_models`
  - Admin models page filters by `is_active` and sorts by `name` or `created_at`

## Existing coverage already present

- `conversations`
  - `user_id`
  - `created_at`
- `messages`
  - `conversation_id`
  - `(conversation_id, created_at)`
- `credit_transactions`
  - `user_id`
  - `(user_id, created_at)`
  - `type`
- `tickets`
  - `user_id`
  - `status`
  - `priority`
- `user_activity_logs`
  - `user_id`
  - `admin_id`
  - `(user_id, created_at)`
  - `action_type`
- `invitations`
  - `status`
  - `created_by`
- `invitation_records`
  - `inviter_id`
  - `status`

## Newly added index coverage

- `profiles(created_at DESC)`
- `profiles(status, created_at DESC)`
- `tickets(created_at DESC)`
- `tickets(status, created_at DESC)`
- `tickets(category, created_at DESC)`
- `tickets(priority, created_at DESC)`
- `credit_transactions(created_at DESC)`
- `credit_transactions(user_id, type, created_at DESC)`
- `announcements(active, priority DESC, created_at DESC)`
- `prompts(active, sort_order DESC, created_at DESC)`
- `prompts(category, active, sort_order DESC, created_at DESC)`
- `invitation_records(created_at DESC)`
- `invitation_records(risk_level, created_at DESC)`
- `invitation_records(ip_address, created_at DESC) WHERE ip_address IS NOT NULL`
- `invitation_records(status, created_at DESC)`
- `ai_models(is_active)`
- `ai_models(name)`

## Follow-up checks

- Run `EXPLAIN ANALYZE` for:
  - admin user list
  - admin tickets list
  - admin transactions list with date filters
  - admin prompts dashboard
  - admin invitations dashboard
- If `ILIKE` search on emails/codes becomes hot, consider trigram indexes in a later migration instead of adding them blindly now.
- If user detail stats keep growing, evaluate a read-model or RPC-backed aggregation path instead of adding more point indexes.
