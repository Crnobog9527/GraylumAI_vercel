/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';

// Explicit aliases only. SQL's combined refusals must not imply a more specific diagnosis.
const aliases: Record<string, string> = {
  outside_refund_window: 'PAY_REFUND_OUTSIDE_WINDOW',
  account_consumed_since_payment: 'PAY_REFUND_CREDITS_CONSUMED',
  not_first_membership_purchase: 'PAY_REFUND_NOT_FIRST_PURCHASE',
  renewal: 'PAY_REFUND_RENEWAL',
  consumption_unresolved: 'PAY_REFUND_CONSUMPTION_UNRESOLVED',
  membership_history_unresolved: 'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED',
  purchase_kind_unresolved: 'PAY_REFUND_PURCHASE_KIND_UNRESOLVED',
  monthly_scope_required: 'PAY_REFUND_MONTHLY_SCOPE_REQUIRED',
  binding_mismatch: 'PAY_REFUND_BINDING_MISMATCH',
  subscription_period_unresolved: 'PAY_REFUND_SUBSCRIPTION_PERIOD_UNRESOLVED',
  monthly_evidence_incomplete: 'PAY_REFUND_EVIDENCE_INCOMPLETE',
  invalid_or_missing_evidence: 'PAY_REFUND_EVIDENCE_INCOMPLETE',
  evidence_identity_mismatch: 'PAY_REFUND_EVIDENCE_IDENTITY_MISMATCH',
  evidence_time_mismatch: 'PAY_REFUND_EVIDENCE_TIME_MISMATCH',
  invalid_payment_amount: 'PAY_REFUND_INVALID_PAYMENT_AMOUNT',
  invalid_refund_amount: 'PAY_REFUND_INVALID_AMOUNT',
  fee_requires_review: 'PAY_REFUND_FEE_REQUIRES_REVIEW',
  unexpected_exception_basis: 'PAY_REFUND_EVIDENCE_INCOMPLETE',
};
const publicCodes = new Set([
  ...Object.values(aliases),
  'PAY_MONTHLY_SCOPE_OR_STATE', 'PAY_REFUND_WINDOW', 'PAY_MONTHLY_CASH', 'PAY_MONTHLY_AMOUNT',
  'PAY_MONTHLY_HISTORY', 'PAY_REFUND_SETTLEMENT_UNRESOLVED', 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN',
  'PAY_REFUND_GRANT_UNRESOLVED', 'PAY_REFUND_VERSION', 'PAY_REFUND_STALE_PREVIEW',
  'PAY_REFUND_ADMIN_REQUIRED', 'PAY_REFUND_SUBJECT_UNAVAILABLE', 'PAY_REFUND_TICKET_MISMATCH',
  'PAY_REFUND_ORDER_UNKNOWN', 'PAY_REFUND_ORDER_UNAVAILABLE', 'PAY_REFUND_HISTORY_INCOMPLETE',
  'PAY_REFUND_MAPPING_UNRESOLVED', 'PAY_REFUND_TEST_SUBSCRIPTION_ONLY', 'PAY_REFUND_SCOPE_MISMATCH',
  'PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE', 'PAY_REFUND_PROVIDER_HISTORY_UNRESOLVED',
  'PAY_REFUND_INVOICE_MISMATCH', 'PAY_REFUND_INVOICE_MISSING', 'PAY_REFUND_INVOICE_PAYMENT_UNRESOLVED',
  'PAY_REFUND_INVOICE_PAYMENT_MISMATCH', 'PAY_REFUND_PAYMENT_MISMATCH', 'PAY_REFUND_CHARGE_MISMATCH',
  'PAY_REFUND_PRIOR_REFUND_OR_DISPUTE', 'PAY_REFUND_PAYMENT_TIME_UNRESOLVED', 'PAY_REFUND_PAYMENT_ORDER_UNRESOLVED',
  'PAY_REFUND_GRANTS_UNRESOLVED', 'PAY_REFUND_FEE_EVIDENCE_REQUIRED', 'PAY_REFUND_STALE_APPROVAL',
  'PAY_REFUND_EVIDENCE_CHANGED', 'PAY_MONTHLY_PROVIDER_EVIDENCE',
]);
export function monthlyRefundPolicyReason(reason: string) {
  return Object.hasOwn(aliases, reason) ? aliases[reason] : 'PAY_REFUND_QUOTE_UNAVAILABLE';
}
function message(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? error.message : null;
}
export function monthlyRefundQuoteError(error: unknown) {
  // Unwrap only our own transaction wrapper, never arbitrary nested provider diagnostics.
  const reason = message(error instanceof Error && error.message === 'PAY_MONTHLY_TRANSACTION_FAILED' ? error.cause : error);
  const known = typeof reason === 'string' && publicCodes.has(reason);
  return new TRPCError({ code: known ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
    message: known ? reason : 'PAY_REFUND_QUOTE_UNAVAILABLE' });
}
