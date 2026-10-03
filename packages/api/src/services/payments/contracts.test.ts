/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { describe, expect, it } from 'vitest';
import { freezePurchaseSnapshot, paymentAmountFactsSchema, purchaseSnapshotSchema } from './contracts';
const quote = {
  version: 1, item_type: 'membership_plan', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-03T00:00:00.000Z', billing_cycle: 'yearly', currency: 'usd', unit: 'major', price: '99.123456789012',
  discount: '0', tax_behavior: 'exclusive', credits: 1200, bonus_credits: 0,
};
describe('payment contract boundary', () => {
  it('copies and freezes exact decimal catalog values without a payment call', () => {
    const input = { ...quote };
    const snapshot = freezePurchaseSnapshot(input);
    input.price = '1';
    expect(snapshot.price).toBe('99.123456789012');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it.each([
    { price: 12.3 }, { price: '1e3' }, { price: '-1' }, { price: '01' },
    { price: '1.1234567890123' }, { credits: -1 }, { credits: 2147483648 },
    { item_updated_at: 'not-a-version' }, { currency: 'USD' }, { billing_cycle: 'one_time' }, { raw_event: {} },
  ])('rejects untrusted or lossy snapshot fields %j', patch => {
    expect(purchaseSnapshotSchema.safeParse({ ...quote, ...patch }).success).toBe(false);
  });
  it('accepts packages only with a one-time contract', () => {
    expect(purchaseSnapshotSchema.safeParse({ ...quote, item_type: 'credit_package', billing_cycle: 'one_time' }).success)
      .toBe(true);
  });
  it('distinguishes unknown fees from confirmed zero without storing a raw payload', () => {
    const fact = { kind: 'fee', amount: null, currency: 'usd', unit: 'major', evidence_ref: 'test_evidence' };
    expect(paymentAmountFactsSchema.parse([fact])[0]?.amount).toBeNull();
    expect(paymentAmountFactsSchema.parse([{ ...fact, amount: '0' }])[0]?.amount).toBe('0');
    expect(paymentAmountFactsSchema.safeParse([{ ...fact, raw_event: {} }]).success).toBe(false);
    expect(paymentAmountFactsSchema.parse([{ ...fact, kind: 'net', amount: '-0.125' }])[0]?.amount).toBe('-0.125');
  });
});
