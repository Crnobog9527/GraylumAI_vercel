/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import { alertOwnerAfterResponse } from '@/lib/owner-alert';

// Only bounded codes, the internal financial record id and evidence deadline. No raw Stripe event or user content.
export function reportPaymentDispute({ code, disputeId, dueBy }) {
  captureMessage(code, { level: 'error', fingerprint: [code, disputeId], tags: { category: 'billing', code },
    extra: { disputeId, evidenceDueBy: dueBy } });
  // ALERT-FEISHU: each dispute step is alerted once by its caller (payment_disputes *_alerted_at); the Feishu key dedupes too.
  alertOwnerAfterResponse('dispute', { code, disputeId: String(disputeId), dueBy: dueBy ?? null });
}
