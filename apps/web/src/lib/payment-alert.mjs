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
