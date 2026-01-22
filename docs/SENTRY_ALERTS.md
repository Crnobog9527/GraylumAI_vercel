# Sentry Alerts Configuration Guide

## Overview

This guide explains how to configure Sentry alerts for GraylumAI to ensure timely notification of errors and issues.

## Access Sentry Dashboard

1. Go to: https://sentry.io/organizations/grayscale-luminary-llc/
2. Select project: `javascript-nextjs`
3. Navigate to: **Alerts** → **Create Alert**

## Recommended Alert Rules

### 1. New Issue Alert (High Priority)

Notify when a completely new error type occurs.

**Configuration:**
```
Name: New Issue Alert
Conditions:
  - A new issue is created
Actions:
  - Send notification via Email
  - (Optional) Send to Slack channel
Frequency: Immediately
```

**Sentry UI Steps:**
1. Alerts → Create Alert → Issues
2. Select "A new issue is created"
3. Add notification action
4. Save

---

### 2. Error Spike Alert (Critical)

Notify when errors increase dramatically.

**Configuration:**
```
Name: Error Spike Alert
Conditions:
  - Number of errors is 10x higher than usual
  - Time window: 1 hour
Actions:
  - Send notification via Email
  - (Optional) PagerDuty integration
Frequency: Every 30 minutes
```

**Sentry UI Steps:**
1. Alerts → Create Alert → Metric Alert
2. Metric: `count()` (number of events)
3. Compare: `percent_change` > 1000% (10x)
4. Time window: 1 hour
5. Add actions

---

### 3. Error Threshold Alert (High)

Notify when errors exceed a threshold.

**Configuration:**
```
Name: High Error Volume
Conditions:
  - Number of errors > 100 in 1 hour
Actions:
  - Send notification via Email
Frequency: Every hour
```

**Sentry UI Steps:**
1. Alerts → Create Alert → Metric Alert
2. Metric: `count()`
3. Threshold: > 100
4. Time window: 1 hour

---

### 4. Critical Error Alert (Critical)

Notify immediately for critical business errors.

**Configuration:**
```
Name: Critical Business Errors
Conditions:
  - Error matches one of:
    - "Payment failed"
    - "AI 服务调用失败"
    - "积分不足"
    - "Database connection"
Actions:
  - Send notification via Email
  - (Optional) PagerDuty/OpsGenie
Frequency: Immediately
```

**Sentry UI Steps:**
1. Alerts → Create Alert → Issues
2. Add filter: `message:*payment* OR message:*AI 服务* OR message:*积分*`
3. Add immediate notification

---

### 5. Performance Alert (Medium)

Notify when API response times degrade.

**Configuration:**
```
Name: Slow API Response
Conditions:
  - Transaction duration P95 > 5 seconds
  - Transaction: /api/*
Actions:
  - Send notification via Email
Frequency: Every hour
```

**Sentry UI Steps:**
1. Alerts → Create Alert → Metric Alert
2. Metric: `p95(transaction.duration)`
3. Filter: `transaction:/api/*`
4. Threshold: > 5000ms

---

## Alert Severity Matrix

| Alert | Severity | Response Time | Notification |
|-------|----------|---------------|--------------|
| New Issue | Medium | 4 hours | Email |
| Error Spike (10x) | Critical | 15 min | Email + Slack |
| High Error Volume | High | 1 hour | Email |
| Critical Business Error | Critical | 15 min | Email + PagerDuty |
| Slow API Response | Medium | 4 hours | Email |

## Notification Channels

### Email (Default)
- Configure in: Settings → Notifications
- Recommended: Team email alias

### Slack Integration
1. Settings → Integrations → Slack
2. Authorize Sentry app
3. Select channel for alerts

### PagerDuty (Production)
1. Settings → Integrations → PagerDuty
2. Add integration key
3. Map alert rules to PagerDuty services

## Environment-Specific Alerts

### Production
- All alerts enabled
- PagerDuty for critical alerts
- 24/7 monitoring

### Staging
- New Issue Alert only
- Email notifications
- Business hours only

### Development
- Alerts disabled
- Manual review via dashboard

## Quick Setup Checklist

- [ ] Create "New Issue Alert"
- [ ] Create "Error Spike Alert"
- [ ] Create "High Error Volume Alert"
- [ ] Create "Critical Business Errors Alert"
- [ ] Create "Slow API Response Alert"
- [ ] Configure Slack integration
- [ ] Test each alert rule
- [ ] Document on-call rotation

## Testing Alerts

Use the Sentry test endpoint to trigger a test error:

```bash
curl https://your-domain.com/api/sentry-test
```

This will create a test error that should trigger your alerts.

## Maintenance

### Weekly Review
- Check alert fatigue (too many non-actionable alerts)
- Adjust thresholds if needed
- Review resolved vs ignored issues

### Monthly Review
- Audit alert rules
- Update thresholds based on traffic
- Review notification channels

## Useful Links

- [Sentry Alerts Documentation](https://docs.sentry.io/product/alerts/)
- [Metric Alerts](https://docs.sentry.io/product/alerts/alert-types/#metric-alerts)
- [Issue Alerts](https://docs.sentry.io/product/alerts/alert-types/#issue-alerts)
