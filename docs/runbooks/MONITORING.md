# Monitoring & Alerts Runbook

## Monitoring Stack Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     Sentry      │     │ Vercel Analytics│     │   Application   │
│  (Errors)       │     │  (Performance)  │     │   Logs (DB)     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                        ┌────────▼────────┐
                        │  Admin Dashboard │
                        │  /admin/costs    │
                        │  /admin/diagnostics│
                        └─────────────────┘
```

## Sentry Error Monitoring

### Access
- URL: https://sentry.io/organizations/grayscale-luminary-llc/
- Project: javascript-nextjs

### Key Metrics to Watch

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Error rate | < 0.1% | 0.1-1% | > 1% |
| Unhandled errors | 0 | 1-5 | > 5 |
| Response time P95 | < 2s | 2-5s | > 5s |

### Alert Configuration

1. **New Issue Alert**: Any new error type
2. **Spike Alert**: 10x increase in errors
3. **Threshold Alert**: > 100 errors/hour

### Common Error Patterns

#### TRPCError
```
Cause: API validation failure, auth error
Action: Check request payload and auth state
```

#### Network Error
```
Cause: API timeout, network issues
Action: Check Anthropic API status, retry logic
```

#### Hydration Error
```
Cause: SSR/Client mismatch
Action: Review component for client-only code
```

## Vercel Analytics

### Access
- URL: https://vercel.com/[team]/[project]/analytics

### Key Metrics

| Metric | Target | Description |
|--------|--------|-------------|
| LCP | < 2.5s | Largest Contentful Paint |
| FID | < 100ms | First Input Delay |
| CLS | < 0.1 | Cumulative Layout Shift |
| TTFB | < 800ms | Time to First Byte |

### Performance Optimization

If LCP > 2.5s:
1. Check image optimization
2. Review server component usage
3. Check API response times

If FID > 100ms:
1. Reduce JavaScript bundle size
2. Defer non-critical scripts
3. Check for blocking operations

## Application Logs

### Log Levels

| Level | Usage |
|-------|-------|
| error | Exceptions, failures |
| warn | Potential issues, deprecations |
| info | Important events, audit trail |
| debug | Development debugging |

### Query Logs

```sql
-- Recent errors
SELECT * FROM application_logs
WHERE level = 'error'
ORDER BY created_at DESC
LIMIT 50;

-- Errors by context
SELECT context, count(*) as count
FROM application_logs
WHERE level = 'error'
  AND created_at > now() - interval '24 hours'
GROUP BY context
ORDER BY count DESC;

-- AI-specific logs
SELECT * FROM application_logs
WHERE context = 'ai'
ORDER BY created_at DESC
LIMIT 50;
```

## AI Usage Monitoring

### Dashboard Location
`/admin/costs`

### Key Metrics

#### Cost Overview Tab
- **Daily cost trend**: Watch for unexpected spikes
- **Model distribution**: Verify routing is working
- **Top users**: Identify heavy users
- **Cache efficiency**: Target > 30%

#### AI Usage Logs Tab
- **Status distribution**: Watch failure rate
- **Latency trends**: Watch for degradation
- **Error patterns**: Identify recurring issues

#### Token Statistics Tab
- **Input/Output ratio**: Usually 3:1 to 5:1
- **Cached tokens**: Higher = better cost efficiency

### Monitoring Queries

```sql
-- Hourly request count
SELECT
  date_trunc('hour', created_at) as hour,
  count(*) as requests,
  count(*) FILTER (WHERE status = 'success') as success,
  count(*) FILTER (WHERE status != 'success') as failed
FROM ai_usage_logs
WHERE created_at > now() - interval '24 hours'
GROUP BY hour
ORDER BY hour DESC;

-- Model usage distribution
SELECT
  model_id,
  count(*) as requests,
  round(100.0 * count(*) / sum(count(*)) OVER (), 2) as percentage
FROM ai_usage_logs
WHERE created_at > now() - interval '7 days'
GROUP BY model_id
ORDER BY requests DESC;

-- Average latency by model
SELECT
  model_id,
  round(avg(latency_ms)) as avg_latency,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)) as p95_latency
FROM ai_usage_logs
WHERE created_at > now() - interval '24 hours'
  AND status = 'success'
GROUP BY model_id;
```

## System Diagnostics

### Dashboard Location
`/admin/diagnostics`

### Test Categories

#### AI Tests (5)
- Smart routing
- Token calculation
- Prompt caching
- Context compression
- Realtime keywords

#### Billing Tests (3)
- Pre-deduct
- Idempotency
- Balance reconciliation

#### Security Tests (3)
- Rate limiting
- Circuit breaker
- RLS isolation

### Expected Results
- **Healthy**: 100% pass rate (11/11)
- **Warning**: 80-99% pass rate
- **Critical**: < 80% pass rate

### Automated Checks
- Vercel Cron runs diagnostics hourly
- Results stored in `diagnostics_results` table

## Alert Response Procedures

### High Error Rate (Sentry)

1. Check Sentry for error details
2. Identify affected users/features
3. Check recent deployments
4. Roll back if deployment-related
5. Fix and deploy hotfix

### Performance Degradation (Vercel)

1. Check Speed Insights for specific pages
2. Review recent code changes
3. Check API latency in ai_usage_logs
4. Check database query performance
5. Scale resources if needed

### Diagnostics Failure

1. Go to `/admin/diagnostics`
2. Identify failing tests
3. Check related services
4. Review test implementation
5. Fix underlying issue

## Monitoring Checklist

### Daily
- [ ] Review Sentry error trends
- [ ] Check Vercel Analytics dashboard
- [ ] Review `/admin/costs` for anomalies

### Weekly
- [ ] Run full diagnostics manually
- [ ] Review AI cost trends
- [ ] Check cache efficiency
- [ ] Review top user spending

### Monthly
- [ ] Audit application logs
- [ ] Review security scan results
- [ ] Check dependency updates
- [ ] Review performance baselines

## Useful Links

| Service | URL |
|---------|-----|
| Sentry | https://sentry.io/organizations/grayscale-luminary-llc/ |
| Vercel | https://vercel.com/dashboard |
| Supabase | https://supabase.com/dashboard |
| Anthropic Status | https://status.anthropic.com |
