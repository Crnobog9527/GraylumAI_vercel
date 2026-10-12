/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { projectBillingStatus, projectOrderPayment } from './orderProjection';
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
  // Still open, or money observed after the close: never hidden as closed.
  expect(projectBillingStatus({ ...closed, qualification_state: 'reserved', purchase_closed_at: null })).toBe('pending');
  expect(projectBillingStatus({ ...closed, payment_status: 'paid' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, qualification_state: 'review' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, fulfilled_at: '2026-10-11T16:50:00Z' })).toBe('pending');
  expect(projectBillingStatus({ ...closed, status: 'completed' })).toBe('completed');
  expect(projectBillingStatus({ status: 'pending' })).toBe('pending');
});
