/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';

// Only bounded codes, the internal financial record id and evidence deadline. No raw Stripe event or user content.
export function reportPaymentDispute({ code, disputeId, dueBy }) {
  captureMessage(code, { level: 'error', fingerprint: [code, disputeId], tags: { category: 'billing', code },
    extra: { disputeId, evidenceDueBy: dueBy } });
}
