/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export const PAYMENT_EVIDENCE_CONFLICT = 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT';

// Exact local validation codes only: transport, database availability, and missing
// mappings are retryable operational failures, not evidence of conflicting money facts.
const evidenceErrors = new Set([
  PAYMENT_EVIDENCE_CONFLICT,
  'PAY_COMMON_RECEIPT_MISMATCH', 'PAY_COMMON_RECEIPT_INVALID',
  'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH', 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH',
  'PAY_COMMON_INVOICE_SOURCE_MISMATCH', 'PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH',
  'PAY_COMMON_SUBSCRIPTION_OWNER_MISMATCH', 'PAY_COMMON_REFUND_IDENTITY_MISMATCH',
  'PAY_COMMON_GRANT_SNAPSHOT_MISMATCH', 'PAY_COMMON_INVOICE_LINE_MISMATCH',
  'upgrade_invoice_source_mismatch', 'upgrade_invoice_quote_mismatch', 'upgrade_price_cadence_mismatch',
  'upgrade_invoice_adjustment_mismatch', 'upgrade_invoice_full_target_line_mismatch',
  'upgrade_invoice_full_target_line_not_unique', 'invoice_subscription_service_period_not_unique',
  'invoice_subscription_service_period_missing',
]);

export function stripeWebhookErrorCode(error: unknown): string {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = current as { message?: unknown; code?: unknown; cause?: unknown };
    if ((typeof entry.message === 'string' && evidenceErrors.has(entry.message))
      || (typeof entry.code === 'string' && evidenceErrors.has(entry.code))) return PAYMENT_EVIDENCE_CONFLICT;
    current = entry.cause;
  }
  return 'PAY_COMMON_WEBHOOK_HANDLER_FAILED';
}
