/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import { PAYMENT_EVIDENCE_CONFLICT } from '@repo/api/src/services/payments/stripeWebhookError';
import { alertOwnerAfterResponse } from '@/lib/owner-alert';

// Keep the platform SDK at the web boundary. Shared API tests consume the narrow
// declaration instead of importing Next's ambient types into the standalone API.
export function reportPaymentEvidenceConflict(eventType) {
  captureMessage(PAYMENT_EVIDENCE_CONFLICT, {
    level: 'error', fingerprint: [PAYMENT_EVIDENCE_CONFLICT],
    tags: { category: 'billing', code: PAYMENT_EVIDENCE_CONFLICT, eventType },
  });
  // ALERT-FEISHU: once a day (the refund and webhook alerts carry the details of each case).
  alertOwnerAfterResponse('billing_review', { code: PAYMENT_EVIDENCE_CONFLICT, count: null });
}

// Fixed code and bounded reasons only: no subject IDs, provider objects or user content leave the cron.
export function reportAnnualReleaseAnomalies(anomalies) {
  if (!anomalies.length) return;
  const code = 'PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'billing', code },
    extra: { count: anomalies.length, reasons: [...new Set(anomalies.map(item => item.reason))] },
  });
  alertOwnerAfterResponse('billing_review', { code, count: anomalies.length });
}

// PAY-STRIPE-MP daily Stripe card backstop: fixed code, counts and bounded kinds only (no order or Stripe ids).
export function reportStripeCardReconciliation(findings) {
  if (!findings.length) return;
  const code = 'PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'billing', code },
    extra: { count: findings.length, kinds: [...new Set(findings.map(item => item.kind))] },
  });
  alertOwnerAfterResponse('billing_review', { code, count: findings.length });
}

// The daily Stripe card backstop is off on a deployed environment (STRIPE_CARD_RECONCILIATION_MODE unset): lost card
// webhooks would never be repaired, silently. Warned once a day (billing_review dedupes per code and day), never a failure.
export function reportStripeCardReconciliationDisabled() {
  const code = 'PAY_STRIPE_MP_RECONCILIATION_DISABLED';
  captureMessage(code, { level: 'warning', fingerprint: [code], tags: { category: 'billing', code } });
  alertOwnerAfterResponse('billing_review', { code, count: null });
}

// PAY-NOTIFY: notices that need a person (uncertain after same-run retries, retries exhausted, digest
// changed, missing template). Fixed codes and counts only: no notice ids, addresses or mail content.
export function reportPaymentNoticeAttention(results) {
  const codes = [...new Set(results.map(item => item.attention).filter(Boolean))];
  if (!codes.length) return;
  const code = 'PAY_NOTIFY_REVIEW_REQUIRED';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'billing', code },
    extra: { count: results.filter(item => item.attention).length, reasons: codes },
  });
  alertOwnerAfterResponse('billing_review', { code, count: results.filter(item => item.attention).length });
}
