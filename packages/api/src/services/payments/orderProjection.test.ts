/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { approvedRefundFact, isRenewalBillingOrder, projectBillingStatus, projectOrderPayment } from './orderProjection';
it('keeps original channel, exact amounts and unknown money without private evidence', () => {
  const facts = [{ kind: 'fee', amount: null, currency: 'usd', unit: 'major', evidence_ref: 'private' },
    { kind: 'paid', amount: '12.000000000001', currency: 'usd', unit: 'major', evidence_ref: 'private' }];
  const result = projectOrderPayment({ payment_channel: 'stripe', payment_mode: 'test', payment_amount_facts: facts },
    { invoicePdfUrl: null, hostedInvoiceUrl: 'https://invoice.stripe.com/example', receiptUrl: null });
  expect(result).toMatchObject({ paymentChannel: 'stripe', documentSource: 'stripe', documentStatus: 'available' });
  expect(result.amountFacts.map(f => f.amount)).toEqual([null, '12.000000000001']);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('marks absent or unsupported credentials unavailable without selecting a new default', () => {
  expect(projectOrderPayment({})).toMatchObject({ paymentChannel: null, documentStatus: 'unknown', amountFacts: [] });
  expect(projectOrderPayment({ payment_channel: 'waffo' })).toMatchObject({ documentSource: 'waffo', documentStatus: 'unavailable' });
});
it('shows a released unpaid checkout as closed while the stored pending state stays for late-payment review', () => {
  const closed = { status: 'pending', payment_status: 'unpaid', fulfilled_at: null, qualification_state: 'released',
    purchase_closed_at: '2026-10-11T16:40:00Z', method_review_reason: 'card_checkout_expired' };
  expect(projectBillingStatus(closed)).toBe('expired');
  expect(projectBillingStatus({ ...closed, method_review_reason: 'verified_checkout_absent' })).toBe('expired');
  expect(projectBillingStatus({ ...closed, method_review_reason: 'card_checkout_rejected' })).toBe('failed');
  expect(projectBillingStatus({ ...closed, method_review_reason: 'async_payment_failed' })).toBe('failed');
  // Still open, or money observed after the close: never hidden as closed.
  expect(projectBillingStatus({ ...closed, qualification_state: 'reserved', purchase_closed_at: null })).toBe('pending');
  expect(projectBillingStatus({ ...closed, payment_status: 'paid' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, qualification_state: 'review' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, fulfilled_at: '2026-10-11T16:50:00Z' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, status: 'completed' })).toBe('completed');
  expect(projectBillingStatus({ status: 'pending' })).toBe('pending');
});
it('immediately displays a failed wallet attempt while its open checkout remains reserved for retry', () => {
  const retryable = { status: 'pending', payment_status: 'unpaid', fulfilled_at: null, qualification_state: 'reserved',
    purchase_closed_at: null, method_review_reason: 'wallet_payment_failed' };
  expect(projectBillingStatus(retryable)).toBe('failed');
  expect(projectBillingStatus({ ...retryable, payment_status: 'paid' })).toBe('pending');
  expect(projectBillingStatus({ ...retryable, status: 'completed', payment_status: 'paid', fulfilled_at: '2026-10-21T00:00:00Z' }))
    .toBe('completed');
  expect(projectBillingStatus({ ...retryable, qualification_state: 'review' })).toBe('pending');
});
it('shows the cash a Graylum-approved refund returned, once, and nothing it cannot prove', () => {
  const facts = [{ kind: 'paid', amount: '496.00', currency: 'usd', unit: 'major', evidence_ref: 'in_1' },
    { kind: 'tax', amount: '24.80', currency: 'usd', unit: 'major', evidence_ref: 'in_1' }];
  const monthly = { kind: 'monthly_first_purchase', status: 'succeeded', recordedRefund: { id: 're_1', status: 'succeeded' },
    terms: { netMinor: 52080, currency: 'usd', taxMinor: 2480 } };
  expect(projectOrderPayment({ payment_channel: 'stripe', payment_amount_facts: facts, refund_approval: monthly }).amountFacts)
    .toEqual([{ kind: 'paid', amount: '496.00', currency: 'usd', unit: 'major' },
      { kind: 'tax', amount: '24.80', currency: 'usd', unit: 'major' },
      { kind: 'refund', amount: '520.80', currency: 'usd', unit: 'major' }]);
  // Credit pack approvals keep the amount at the top level.
  expect(approvedRefundFact({ status: 'succeeded', refundId: 're_2', netMinor: 940, currency: 'usd' }))
    .toEqual({ kind: 'refund', amount: '9.40', currency: 'usd', unit: 'major' });
  expect(approvedRefundFact({ status: 'succeeded', refundId: 're_3', netMinor: 5, currency: 'usd' })?.amount).toBe('0.05');
  // An external refund already recorded its own fact: never shown twice.
  const recorded = [...facts, { kind: 'refund', amount: '520.80', currency: 'usd', unit: 'major', evidence_ref: 're_1' }];
  expect(projectOrderPayment({ payment_amount_facts: recorded, refund_approval: monthly }).amountFacts
    .filter(fact => fact.kind === 'refund')).toHaveLength(1);
  // Not finished, no Stripe refund recorded, or amounts that are not exact minor units: nothing.
  for (const approval of [null, { ...monthly, status: 'approved' }, { ...monthly, recordedRefund: { id: 're_1', status: 'pending' } },
    { ...monthly, recordedRefund: undefined }, { ...monthly, terms: { netMinor: 520.8, currency: 'usd' } },
    { ...monthly, terms: { netMinor: 0, currency: 'usd' } }, { ...monthly, terms: { netMinor: '52080', currency: 'usd' } },
    { ...monthly, terms: { netMinor: 52080, currency: 'USD$' } }, { status: 'succeeded', netMinor: 940, currency: 'usd' }])
    expect(approvedRefundFact(approval)).toBeNull();
  expect(projectOrderPayment({ payment_amount_facts: facts, refund_approval: { ...monthly, status: 'approved' } }).amountFacts)
    .toHaveLength(2);
});
it('labels only automatic and founder renewals as renewal bills', () => {
  const card = { item_type: 'membership_plan', payment_method: 'card', source_order_id: 'first', method_transition: null };
  expect(isRenewalBillingOrder(card)).toBe(true);
  expect(isRenewalBillingOrder({ ...card, payment_method: 'card_cn' })).toBe(true);
  expect(isRenewalBillingOrder({ ...card, source_order_id: null })).toBe(false);
  expect(isRenewalBillingOrder({ ...card, method_transition: 'upgrade' })).toBe(false);
  expect(isRenewalBillingOrder({ ...card, payment_method: 'wechat_pay', method_transition: 'wallet_renewal' })).toBe(false);
  expect(isRenewalBillingOrder({ item_type: 'membership_plan', payment_method: 'wechat_pay', offer_kind: 'founder_renewal' })).toBe(true);
  expect(isRenewalBillingOrder({ item_type: 'membership_plan', purchase_action: 'renewal', source_order_id: 'first' })).toBe(true);
  expect(isRenewalBillingOrder({ ...card, item_type: 'credit_package' })).toBe(false);
});
