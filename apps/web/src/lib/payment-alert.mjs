/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import { PAYMENT_EVIDENCE_CONFLICT } from '@repo/api/src/services/payments/stripeWebhookError';

// Keep the platform SDK at the web boundary. Shared API tests consume the narrow
// declaration instead of importing Next's ambient types into the standalone API.
export function reportPaymentEvidenceConflict(eventType) {
  captureMessage(PAYMENT_EVIDENCE_CONFLICT, {
    level: 'error', fingerprint: [PAYMENT_EVIDENCE_CONFLICT],
    tags: { category: 'billing', code: PAYMENT_EVIDENCE_CONFLICT, eventType },
  });
}

// Fixed code and bounded reasons only: no subject IDs, provider objects or user content leave the cron.
export function reportAnnualReleaseAnomalies(anomalies) {
  if (!anomalies.length) return;
  const code = 'PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'billing', code },
    extra: { count: anomalies.length, reasons: [...new Set(anomalies.map(item => item.reason))] },
  });
}

// PAY-STRIPE-MP daily Stripe card backstop: fixed code, counts and bounded kinds only (no order or Stripe ids).
export function reportStripeCardReconciliation(findings) {
  if (!findings.length) return;
  const code = 'PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED';
  captureMessage(code, {
    level: 'error', fingerprint: [code], tags: { category: 'billing', code },
    extra: { count: findings.length, kinds: [...new Set(findings.map(item => item.kind))] },
  });
}
