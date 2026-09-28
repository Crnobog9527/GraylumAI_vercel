# Database Operations Runbook

For staging rebuild reproducibility, see
[`STAGING_REPRODUCIBILITY.md`](./STAGING_REPRODUCIBILITY.md).
For raw SQL migration execution evidence, see
[`RAW_SQL_MIGRATION_LEDGER.md`](./RAW_SQL_MIGRATION_LEDGER.md).
For staging drift checks, run the read-only readiness script documented there
before planning any repair SQL.

## Connection Details

```
Host: See SUPABASE_URL in .env
Database: postgres
Schema: public
ORM: Drizzle
```

## Common Operations

### Running Migrations

For a routine incremental migration, follow only the current task's reviewed,
environment-specific migration plan under [AGENTS.md](../../AGENTS.md): identify
the exact target and pending files from `packages/db/migrations/`, obtain the
required approval, apply only the approved migration scope, and verify its
postconditions. Record execution evidence in the
[raw SQL migration ledger](./RAW_SQL_MIGRATION_LEDGER.md) where applicable.
Do not treat this section as approval to paste arbitrary SQL into SQL Editor.

[`STAGING_REPRODUCIBILITY.md`](./STAGING_REPRODUCIBILITY.md) is a separate checklist
for an explicitly scoped fresh staging rebuild or drift recovery, not the routine
incremental migration procedure. Its schema-push and seed steps must not be run
as implicit prerequisites to an incremental migration. Table structure is
authoritative in `packages/db/migrations/`, not `schema.ts`; any rebuild or repair
still needs its own reviewed scope and applicable approval. The staging checklist
is not a production procedure.

### User Management

#### Find User by Email
```sql
SELECT id, email, nickname, role, status, credits, membership_level
FROM profiles
WHERE email = 'user@example.com';
```

#### Adjust User Credits

Use the credit adjustment control in `/admin/users`, with the adjustment amount
and reason. The UI calls `admin.adjustUserCredits`, which uses
`atomic_apply_credit_ledger_entry` for the balance and ledger mutation. The later
admin activity insert is best-effort: the router does not check its returned error,
so a successful adjustment response does not guarantee an admin audit record.
Verify the expected activity record separately; do not repeat a successful credit
adjustment just to recover a missing log. Do not update `profiles.credits` and
insert a ledger row as separate manual SQL operations.

After a timeout, connection error, or other ambiguous response, inspect the actual
user balance and credit ledger before any retry. The UI currently sends no
`idempotencyKey`, and the router supplies an RPC key only when the caller provides
one; resubmitting can apply the same credit delta twice. If the ledger confirms
success, do not resubmit. If the outcome remains uncertain, stop and investigate
rather than retrying. Sources: `apps/web/src/app/admin/users/page.tsx:178`–`:182`
and `packages/api/src/routers/admin.ts:1061`–`:1063`.

Code: `apps/web/src/app/admin/users/page.tsx:141`,
`packages/api/src/routers/admin.ts:1029` (RPC call at line 1066; separate activity
insert at lines 1083–1095).
Production or real-user adjustments still require the applicable approval in
[AGENTS.md](../../AGENTS.md).

#### Change User Role
```sql
UPDATE profiles
SET role = 'admin'  -- or 'user'
WHERE id = 'USER_UUID';

-- Log the change
INSERT INTO user_activity_logs (user_id, admin_id, action, action_type)
VALUES (
  'USER_UUID',
  'ADMIN_UUID',
  'Changed role to admin',
  'role_change'
);
```

#### Disable User Account
```sql
UPDATE profiles
SET status = 'disabled'
WHERE id = 'USER_UUID';
```

### Conversation Management

#### Soft Delete User's Conversations
```sql
UPDATE conversations
SET is_deleted = 'true', deleted_at = now()
WHERE user_id = 'USER_UUID'
  AND is_deleted = 'false';
```

#### Hard Delete Old Soft-Deleted Data

A direct `DELETE FROM conversations` does not guarantee that matching rows are
removed. The `artifact_chat_delete` and `ordinary_chat_delete` BEFORE DELETE
triggers can return `NULL`, silently skipping a row: artifact conversations with
a project row that cannot be locked (busy or missing), or active/uncertain generations, and ordinary
conversations with nonterminal requests, are protected. A successful SQL command
alone is not evidence of completed deletion; verify affected rows and retained
context. Do not disable these guards to force cleanup.

Sources: `packages/db/migrations/0069_v3_chat_skill.sql:43` and
`packages/db/migrations/0078_ordinary_chat_requests.sql:30`.

### Analytics Queries

#### Daily Active Users
```sql
SELECT
  date_trunc('day', created_at) as day,
  count(DISTINCT user_id) as active_users
FROM ai_usage_logs
WHERE created_at > now() - interval '30 days'
GROUP BY day
ORDER BY day DESC;
```

#### Revenue by Model
```sql
SELECT
  model_used,
  count(*) as requests,
  sum(total_credits) as total_credits,
  sum(total_cost_usd) as total_cost_usd
FROM token_stats
WHERE created_at > now() - interval '30 days'
GROUP BY model_used
ORDER BY total_credits DESC;
```

#### Top Users by Spending
```sql
SELECT
  p.email,
  p.nickname,
  sum(ts.total_credits) as total_spent
FROM token_stats ts
JOIN profiles p ON ts.user_id = p.id
WHERE ts.created_at > now() - interval '30 days'
GROUP BY p.id, p.email, p.nickname
ORDER BY total_spent DESC
LIMIT 20;
```

#### Cache Efficiency
```sql
SELECT
  date_trunc('day', created_at) as day,
  sum(cached_tokens) as cached,
  sum(input_tokens) as total_input,
  round(100.0 * sum(cached_tokens) / nullif(sum(input_tokens), 0), 2) as cache_rate
FROM token_stats
WHERE created_at > now() - interval '7 days'
GROUP BY day
ORDER BY day DESC;
```

### Data Cleanup

#### Clean Old Logs
```sql
-- Application logs (30 days)
DELETE FROM application_logs
WHERE created_at < now() - interval '30 days';

-- Diagnostics results (30 days)
DELETE FROM diagnostic_results
WHERE created_at < now() - interval '30 days';
```

#### Clean Expired Invitations
```sql
UPDATE invitations
SET status = 'expired'
WHERE status = 'active'
  AND created_at < now() - interval '7 days';
```

### Backup Operations

#### Export User Data (GDPR)
```sql
-- Get all user data for export
SELECT json_build_object(
  'profile', (SELECT row_to_json(p) FROM profiles p WHERE p.id = 'USER_UUID'),
  'conversations', (
    SELECT json_agg(row_to_json(c))
    FROM conversations c
    WHERE c.user_id = 'USER_UUID'
  ),
  'messages', (
    SELECT json_agg(row_to_json(m))
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.user_id = 'USER_UUID'
  )
) as user_data;
```

### Performance Monitoring

#### Check Index Usage
```sql
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;
```

#### Find Slow Queries
```sql
SELECT
  query,
  calls,
  mean_time,
  total_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;
```

#### Table Sizes
```sql
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Emergency Procedures

### Reset User Password
Use Supabase Dashboard → Authentication → Users → Find user → Reset password

### Disable RLS Temporarily (Emergency Only)
```sql
-- CAUTION: Only for emergency debugging
ALTER TABLE tablename DISABLE ROW LEVEL SECURITY;

-- Remember to re-enable!
ALTER TABLE tablename ENABLE ROW LEVEL SECURITY;
```

### Kill Long-Running Queries
```sql
-- Find the PID
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;

-- Kill it
SELECT pg_terminate_backend(PID_HERE);
```

## Scheduled Tasks

| Task | Schedule | Function |
|------|----------|----------|
| Log cleanup | Not scheduled by repository configuration | `cleanup_old_logs()` exists; no scheduled caller is configured |
| Diagnostics | Daily at 10:00 UTC (`0 10 * * *`) | `/api/cron/diagnostics` |

`cleanup_old_logs()` is defined in `packages/db/migrations/0006_application_logs.sql:58`.
The repository schedule is in `apps/web/vercel.json`; function existence does not
prove that a remote scheduler is configured. No remote scheduler was inspected.

## Supabase Dashboard Links

- SQL Editor: Project → SQL Editor
- Table Editor: Project → Table Editor
- Auth Users: Project → Authentication → Users
- Logs: Project → Database → Logs
