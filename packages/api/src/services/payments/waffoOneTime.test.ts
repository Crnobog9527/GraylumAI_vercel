/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { describe, expect, it } from 'vitest';
import { payment } from './waffoTestHarness';
import { readPaymentFacts } from './waffoPayments';
import { buildWaffoOneTimeCheckoutRequest } from './waffoCheckout';
const oneTime = () => payment({ periodNumber: null, subscriptionOrder: null, onetimeOrder: {
  id: 'ORD_fixture1', storeId: 'STO_fixture', status: 'completed', testMode: true,
  orderMerchantExternalId: '00000000-0000-4000-8000-000000000001', onetimeProduct: { id: 'PROD_oneTime' },
} });
describe('Waffo emergency one-time facts', () => {
  it('accepts card and simulated Alipay with no period or subscription', () => {
    expect(readPaymentFacts(oneTime(), 'STO_fixture')).toMatchObject({ kind: 'paid', facts: { purchaseMode: 'payment', method: 'card', periodNumber: null } });
    expect(readPaymentFacts({ ...oneTime(), paymentMethod: { type: 'alipay' } }, 'STO_fixture')).toMatchObject({ kind: 'paid', facts: { method: 'alipay' } });
  });
  it('preserves proven cash with an unknown actual method for manual handling', () => {
    expect(readPaymentFacts({ ...oneTime(), paymentMethod: { type: 'unconfirmed_alipay_field' } }, 'STO_fixture'))
      .toMatchObject({ kind: 'paid', facts: { method: 'unknown', amountCents: 6900 } });
  });
  it('requires matching merchant store, payment mode and business identity', () => {
    expect(readPaymentFacts(oneTime(), 'STO_other').kind).toBe('unknown');
    expect(readPaymentFacts({ ...oneTime(), testMode: false }, 'STO_fixture').kind).toBe('unknown');
    const live = oneTime(); live.testMode = false; live.onetimeOrder!.testMode = false;
    expect(readPaymentFacts(live, 'STO_fixture', 'live').kind).toBe('paid');
    live.onetimeOrder!.orderMerchantExternalId = 'other';
    expect(readPaymentFacts(live, 'STO_fixture', 'live').kind).toBe('unknown');
  });
  it('builds membership/pack checkout without trial or subscription and leaves hosted methods automatic', () => {
    const snapshot = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000001',
      item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
      price: '49.00', discount: '0.00', tax_behavior: 'inclusive', credits: 8970, bonus_credits: 0 };
    const order = { id: '00000000-0000-4000-8000-000000000002', user_id: '00000000-0000-4000-8000-000000000003',
      payment_mode: 'live' as const, payment_channel: 'waffo', payment_method: 'card', merchant_namespace: 'fixture',
      offer_kind: 'gold_first30', purchase_snapshot: snapshot };
    const request = buildWaffoOneTimeCheckoutRequest({ order, productId: 'PROD_oneTime', merchantNamespace: 'fixture', appUrl: 'https://app.example.invalid' });
    expect(request.withTrial).toBe(false); expect(request).not.toHaveProperty('includePaymentMethods');
    expect(request).not.toHaveProperty('subscription');
    expect(request.orderMerchantExternalId).toBe(order.id);
  });
});
