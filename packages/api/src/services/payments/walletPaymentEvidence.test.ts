/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, it, expect, vi } from 'vitest';
import { readWalletPaymentEvidence } from './walletPaymentEvidence';
import { buildStripeCheckoutRequest } from './stripeCheckoutIntent';
import { assertStripePurchasePrice } from './stripePurchaseEvidence';
const snapshot = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000001',
  item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'yearly', currency: 'usd', unit: 'major',
  price: '496.00', discount: '0.00', tax_behavior: 'inclusive', credits: 107640, bonus_credits: 0 };
const order = { id: 'order-1', user_id: 'user-1', payment_method: 'wechat_pay' as const, purchase_snapshot: snapshot };
function fixture() {
  const metadata = { orderId: order.id, userId: order.user_id };
  const session = { object: 'checkout.session', id: 'cs_1', mode: 'payment', livemode: false, client_reference_id: order.user_id, metadata,
    payment_method_types: ['wechat_pay'], payment_status: 'paid', amount_total: 49600, currency: 'usd',
    payment_intent: 'pi_1', customer: 'cus_1' };
  const intent = { object: 'payment_intent', id: 'pi_1', livemode: false, status: 'succeeded', latest_charge: 'ch_1', metadata,
    customer: 'cus_1', amount_received: 49600, currency: 'usd' };
  const charge = { object: 'charge', id: 'ch_1', livemode: false, paid: true, captured: true, status: 'succeeded',
    payment_intent: 'pi_1', payment_method_details: { type: 'wechat_pay' }, refunded: false, amount_refunded: 0,
    customer: 'cus_1', amount_captured: 49600, currency: 'usd', created: 1791676800 };
  const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } },
    paymentIntents: { retrieve: vi.fn().mockResolvedValue(intent) }, charges: { retrieve: vi.fn().mockResolvedValue(charge) } };
  const run = () => readWalletPaymentEvidence({ stripe: stripe as unknown as Stripe, scope: { merchant: 'fixture', mode: 'test' },
    order, sessionId: 'cs_1' });
  return { session, intent, charge, stripe, run };
}
describe('wallet one-time evidence', () => {
  it.each(['wechat_pay', 'alipay'] as const)('creates one-time annual membership via %s only', method => {
    const request = buildStripeCheckoutRequest({ orderId: 'order', userId: 'user', snapshot, priceId: 'price_1',
      productName: 'Founder', appUrl: 'https://app.example.invalid', expiresAt: 1800000000, walletMethod: method });
    expect(request.mode).toBe('payment'); expect(request.payment_method_types).toEqual([method]);
    expect(request.subscription_data).toBeUndefined();
    const price = { id: 'price_1', object: 'price', active: true, livemode: false, currency: 'usd', unit_amount: 49600,
      billing_scheme: 'per_unit', tax_behavior: 'inclusive', type: 'one_time', recurring: null } as Stripe.Price;
    expect(() => assertStripePurchasePrice({ price, priceId: price.id, snapshot,
      scope: { merchant: 'fixture', mode: 'test' }, walletMethod: method })).not.toThrow();
  });
  it('requires actual payment, returns original payment identity', async () => {
    const f = fixture(); expect((await f.run())?.paymentId).toBe('pi_1');
    f.session.payment_status = 'unpaid'; expect(await f.run()).toBeNull();
  });
  it.each(['owner', 'amount', 'method', 'refund', 'mode', 'pending'] as const)('rejects %s conflict', async reason => {
    const f = fixture();
    if (reason === 'owner') f.session.client_reference_id = 'other-user';
    if (reason === 'amount') f.charge.amount_captured = 49599;
    if (reason === 'method') f.charge.payment_method_details.type = 'card';
    if (reason === 'refund') f.charge.amount_refunded = 1;
    if (reason === 'mode') f.intent.livemode = true;
    if (reason === 'pending') f.intent.status = 'processing';
    await expect(f.run()).rejects.toThrow();
  });
  it('propagates lookup timeout without interpreting it as unpaid', async () => {
    const f = fixture(); f.stripe.charges.retrieve.mockRejectedValue(new Error('timeout'));
    await expect(f.run()).rejects.toThrow('timeout');
  });
});
