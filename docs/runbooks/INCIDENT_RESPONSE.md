# Incident Response Runbook

## Quick Reference

| Severity | Response Time | Examples |
|----------|---------------|----------|
| P0 - Critical | 15 min | Site down, data loss, security breach |
| P1 - High | 1 hour | Core feature broken, billing errors |
| P2 - Medium | 4 hours | Performance degradation, minor bugs |
| P3 - Low | 24 hours | UI issues, non-critical features |

## Incident Detection

### Automated Alerts
- **Sentry**: Error spikes, new error types
- **Vercel**: Build failures, deployment errors
- **Supabase**: Database connection issues

### Manual Detection
- User reports via support tickets
- Admin dashboard anomalies
- Diagnostics page failures (`/admin/diagnostics`)

## Response Procedures

### Step 1: Assess

```bash
# Check Sentry for errors
# https://sentry.io/organizations/grayscale-luminary-llc/issues/

# Check Vercel deployment status
# https://vercel.com/dashboard

# Check system diagnostics
curl https://your-domain.com/api/cron/diagnostics
```

### Step 2: Communicate

1. Acknowledge in team channel
2. Update status page if public-facing
3. Assign incident commander

### Step 3: Investigate

#### Database Issues
```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Check slow queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC
LIMIT 10;
```

#### Application Issues
```bash
# Check application logs in Supabase
SELECT * FROM application_logs
WHERE level = 'error'
ORDER BY created_at DESC
LIMIT 50;

# Check AI usage errors
SELECT * FROM ai_usage_logs
WHERE status != 'success'
ORDER BY created_at DESC
LIMIT 50;
```

### Step 4: Mitigate

#### Quick Fixes

| Issue | Mitigation |
|-------|------------|
| High error rate | Enable maintenance mode |
| Database overload | Scale Supabase instance |
| API rate limited | Reduce request rate |
| Memory issues | Restart serverless functions |

#### Rollback Deployment
```bash
# Via Vercel Dashboard
# 1. Go to Deployments
# 2. Find last working deployment
# 3. Click "..." → "Promote to Production"
```

### Step 5: Resolve

1. Deploy fix or confirm mitigation
2. Verify resolution with diagnostics
3. Monitor for 30 minutes

### Step 6: Post-Mortem

Document within 48 hours:
- Timeline of events
- Root cause analysis
- Actions taken
- Prevention measures

## Common Issues

### Issue: AI Requests Failing

**Symptoms**: High error rate in ai_usage_logs

**Investigation**:
```sql
SELECT status, count(*),
       date_trunc('minute', created_at) as minute
FROM ai_usage_logs
WHERE created_at > now() - interval '1 hour'
GROUP BY status, minute
ORDER BY minute DESC;
```

**Common Causes**:
1. Anthropic API issues → Check status.anthropic.com
2. Invalid API key → Verify ANTHROPIC_API_KEY
3. Rate limiting → Check rate limiter logs

**Resolution**:
- If API issue: Wait for upstream fix
- If key issue: Rotate key in Vercel env vars
- If rate limit: Adjust limits in rateLimiter.ts

### Issue: Billing Discrepancies

**Symptoms**: User reports incorrect credit balance

**Investigation**:
```sql
-- Check user's credit history
SELECT * FROM billing_history
WHERE user_id = 'USER_UUID'
ORDER BY created_at DESC
LIMIT 20;

-- Check for orphaned pre-deducts
SELECT * FROM billing_history
WHERE user_id = 'USER_UUID'
  AND operation_type = 'pre_deduct'
  AND NOT EXISTS (
    SELECT 1 FROM billing_history b2
    WHERE b2.metadata->>'preDeductId' = billing_history.id::text
  );
```

**Resolution**:
1. Identify orphaned transactions
2. Calculate correct balance
3. Apply manual adjustment via admin panel
4. Log action in user_activity_logs

### Issue: High Latency

**Symptoms**: Slow response times, user complaints

**Investigation**:
```sql
-- Check average latency
SELECT
  date_trunc('hour', created_at) as hour,
  avg(latency_ms) as avg_latency,
  max(latency_ms) as max_latency
FROM ai_usage_logs
WHERE created_at > now() - interval '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

**Common Causes**:
1. Long conversation context → Check context compression
2. Complex queries → Review model routing
3. Database slow → Check connection pool

**Resolution**:
- Enable aggressive context compression
- Verify index usage with EXPLAIN ANALYZE
- Scale database if needed

### Issue: Authentication Failures

**Symptoms**: Users can't log in

**Investigation**:
- Check Supabase Auth status
- Review browser console for errors
- Check CORS configuration

**Resolution**:
1. Verify Supabase Auth settings
2. Check environment variables
3. Clear user's browser cache/cookies

## Emergency Contacts

| Role | Contact |
|------|---------|
| On-call Engineer | (Configure in PagerDuty) |
| Database Admin | (Configure) |
| Security Lead | (Configure) |

## Escalation Path

```
L1 Support → On-call Engineer → Team Lead → CTO
```
