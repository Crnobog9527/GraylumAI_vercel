/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { freezePurchaseSnapshot } from './contracts';
import {
  assertPurchaseReceipt, centsToMajor, checkoutIdempotencyKey, frozenGrantCredits,
  majorToCents, purchasePayloadHash, snapshotAmountDue,
} from './purchaseFacts';

const snapshot = freezePurchaseSnapshot({
  version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd',
  unit: 'major', price: '19.99', discount: '2.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20,
});

describe('frozen Stripe purchase facts', () => {
  it('preserves cents without floating point subtraction or rounding', () => {
    expect(centsToMajor(1999)).toBe('19.99');
    expect(majorToCents('19.99')).toBe(1999);
    expect(snapshotAmountDue(snapshot)).toBe(1799);
    expect(frozenGrantCredits(snapshot)).toBe(120);
  });
  it.each(['1.001', '-1', '1e2', '01.00', 'NaN', '99999999999999.99'])('rejects ambiguous money %s', amount => {
    expect(() => majorToCents(amount)).toThrow('PAY_COMMON_AMOUNT_INVALID');
  });
  it.each([NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe cents %s', cents => {
    expect(() => centsToMajor(cents)).toThrow('PAY_COMMON_AMOUNT_INVALID');
  });
  it('compares receipt mode, currency and exact frozen amount', () => {
    const receipt = { snapshot, amount: 1799, currency: 'usd', livemode: false,
      scope: { merchant: 'acct_fixture', mode: 'test' as const } };
    expect(assertPurchaseReceipt(receipt)).toEqual(snapshot);
    for (const patch of [{ amount: 1800 }, { amount: null }, { currency: 'eur' }, { livemode: true }]) {
      expect(() => assertPurchaseReceipt({ ...receipt, ...patch })).toThrow('PAY_COMMON_RECEIPT_MISMATCH');
    }
  });
  it('keeps an order key stable while separate orders remain separate purchases', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    expect(checkoutIdempotencyKey(first)).toBe(checkoutIdempotencyKey(first));
    expect(checkoutIdempotencyKey(first)).not.toBe(checkoutIdempotencyKey(second));
    expect(() => checkoutIdempotencyKey('cs_test_fixture')).toThrow('PAY_COMMON_ORDER_INVALID');
  });
  it('hashes only the explicit purchase action in stable order', () => {
    const action = { itemType: 'membership_plan' as const, itemId: snapshot.item_id, billingCycle: 'monthly' as const };
    expect(purchasePayloadHash(action)).toBe(purchasePayloadHash({ ...action }));
    expect(purchasePayloadHash(action)).not.toBe(purchasePayloadHash({ ...action, billingCycle: 'yearly' }));
  });
  it('does not guess unsupported currency, tax, discount or overflow', () => {
    expect(() => snapshotAmountDue({ ...snapshot, currency: 'jpy' })).toThrow();
    expect(() => snapshotAmountDue({ ...snapshot, tax_behavior: 'exclusive' })).toThrow();
    expect(() => snapshotAmountDue({ ...snapshot, discount: '20' })).toThrow();
    expect(() => frozenGrantCredits({ ...snapshot, credits: 2147483647 })).toThrow();
  });
});
