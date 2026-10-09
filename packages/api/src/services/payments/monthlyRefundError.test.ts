/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { monthlyRefundPolicyReason, monthlyRefundQuoteError } from './monthlyRefundError';

it.each([
  ['outside_refund_window', 'PAY_REFUND_OUTSIDE_WINDOW'],
  ['account_consumed_since_payment', 'PAY_REFUND_CREDITS_CONSUMED'],
  ['not_first_membership_purchase', 'PAY_REFUND_NOT_FIRST_PURCHASE'],
  ['renewal', 'PAY_REFUND_RENEWAL'],
  ['consumption_unresolved', 'PAY_REFUND_CONSUMPTION_UNRESOLVED'],
  ['membership_history_unresolved', 'PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED'],
  ['purchase_kind_unresolved', 'PAY_REFUND_PURCHASE_KIND_UNRESOLVED'],
  ['monthly_scope_required', 'PAY_REFUND_MONTHLY_SCOPE_REQUIRED'],
  ['binding_mismatch', 'PAY_REFUND_BINDING_MISMATCH'],
  ['subscription_period_unresolved', 'PAY_REFUND_SUBSCRIPTION_PERIOD_UNRESOLVED'],
  ['monthly_evidence_incomplete', 'PAY_REFUND_EVIDENCE_INCOMPLETE'],
  ['invalid_or_missing_evidence', 'PAY_REFUND_EVIDENCE_INCOMPLETE'],
  ['evidence_identity_mismatch', 'PAY_REFUND_EVIDENCE_IDENTITY_MISMATCH'],
  ['evidence_time_mismatch', 'PAY_REFUND_EVIDENCE_TIME_MISMATCH'],
  ['invalid_payment_amount', 'PAY_REFUND_INVALID_PAYMENT_AMOUNT'],
  ['invalid_refund_amount', 'PAY_REFUND_INVALID_AMOUNT'],
  ['fee_requires_review', 'PAY_REFUND_FEE_REQUIRES_REVIEW'],
  ['unexpected_exception_basis', 'PAY_REFUND_EVIDENCE_INCOMPLETE'],
])('maps existing policy reason %s without changing the decision', (reason, code) => {
  expect(monthlyRefundPolicyReason(reason)).toBe(code);
  expect(monthlyRefundQuoteError(new Error(code))).toMatchObject({ code: 'BAD_REQUEST', message: code });
});
it.each(['PRIVATE_DIAGNOSTIC', 'PAY_REFUND_WINDOW private-detail', 'toString', '__proto__'])
  ('does not expose unknown or extended error %s', reason => {
    expect(monthlyRefundPolicyReason(reason)).toBe('PAY_REFUND_QUOTE_UNAVAILABLE');
    expect(monthlyRefundQuoteError(new Error(reason)).message).toBe('PAY_REFUND_QUOTE_UNAVAILABLE');
  });
it('does not unwrap arbitrary provider causes', () => {
  expect(monthlyRefundQuoteError(new Error('provider', { cause: { message: 'PAY_REFUND_WINDOW' } })).message)
    .toBe('PAY_REFUND_QUOTE_UNAVAILABLE');
});
