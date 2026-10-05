/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { projectOrderPayment } from './orderProjection';
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
