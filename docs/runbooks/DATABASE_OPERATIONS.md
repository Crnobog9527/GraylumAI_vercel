# Database Operations Runbook

## Connection Details

```
Host: See SUPABASE_URL in .env
Database: postgres
Schema: public
ORM: Drizzle
```

## Common Operations

### Running Migrations

```bash
# Check pending migrations
ls packages/db/migrations/

# Apply via Supabase Dashboard
# 1. Go to SQL Editor
# 2. Paste migration content
# 3. Execute
```

### User Management

#### Find User by Email
```sql
SELECT id, email, nickname, role, status, credits, membership_level
FROM profiles
WHERE email = 'user@example.com';
```

#### Adjust User Credits
```sql
-- Add credits (e.g., support compensation)
UPDATE profiles
SET credits = credits + 100
WHERE id = 'USER_UUID';

-- Log the adjustment
INSERT INTO credit_transactions (user_id, amount, type, description)
VALUES ('USER_UUID', 100, 'addition', 'Support compensation');

-- Log admin action
INSERT INTO user_activity_logs (user_id, admin_id, action, action_type, details)
VALUES (
  'USER_UUID',
  'ADMIN_UUID',
  'Added 100 credits for support compensation',
  'credit_adjustment',
  '{"amount": 100, "reason": "Support compensation"}'::jsonb
);
```

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
```sql
-- Delete conversations older than 30 days
DELETE FROM conversations
WHERE is_deleted = 'true'
  AND deleted_at < now() - interval '30 days';
```

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
DELETE FROM diagnostics_results
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
| Log cleanup | Daily | `cleanup_old_logs()` |
| Diagnostics | Hourly | `/api/cron/diagnostics` |

## Supabase Dashboard Links

- SQL Editor: Project → SQL Editor
- Table Editor: Project → Table Editor
- Auth Users: Project → Authentication → Users
- Logs: Project → Database → Logs
