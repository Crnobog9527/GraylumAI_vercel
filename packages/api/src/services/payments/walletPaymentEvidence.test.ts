/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { describe, it, expect, vi } from 'vitest';
import { readWalletPaymentEvidence } from './walletPaymentEvidence';
import { buildStripeCheckoutRequest } from './stripeCheckoutIntent';
import { assertStripePurchasePrice } from './stripePurchaseEvidence';
const snapshot = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000001',
  item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'yearly', currency: 'usd', unit: 'major',
  price: '496.00', discount: '0.00', tax_behavior: 'inclusive', credits: 107640, bonus_credits: 0 };
const order = { payment_channel: 'stripe', merchant_namespace: 'fixture', payment_mode: 'test', id: 'order-1', user_id: 'user-1', payment_method: 'wechat_pay' as const, purchase_snapshot: snapshot };
function fixture(method: 'wechat_pay' | 'alipay' = 'wechat_pay') {
  const purchaseOrder = { ...order, payment_method: method };
  const metadata = { orderId: order.id, userId: order.user_id };
  const session = { object: 'checkout.session', id: 'cs_1', mode: 'payment', livemode: false, client_reference_id: order.user_id, metadata,
    payment_method_types: [String(method)], payment_status: 'paid', amount_total: 49600, currency: 'usd',
    payment_intent: 'pi_1' as string | null, customer: 'cus_1', status: 'open' };
  const intent = { object: 'payment_intent', id: 'pi_1', livemode: false, status: 'succeeded', latest_charge: 'ch_1', metadata,
    customer: 'cus_1', amount_received: 49600, amount: 49600, currency: 'usd', payment_method_types: [String(method)],
    last_payment_error: null as { code: string } | null };
  const charge = { object: 'charge', id: 'ch_1', livemode: false, paid: true, captured: true, status: 'succeeded',
    payment_intent: 'pi_1', payment_method_details: { type: String(method) }, refunded: false, amount_refunded: 0,
    customer: 'cus_1', amount: 49600, amount_captured: 49600, currency: 'usd', created: 1791676800 };
  const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue(session) } },
    paymentIntents: { retrieve: vi.fn().mockResolvedValue(intent) }, charges: { retrieve: vi.fn().mockResolvedValue(charge) } };
  const failed = vi.fn();
  const run = () => readWalletPaymentEvidence({ stripe: stripe as unknown as Stripe, scope: { merchant: 'fixture', mode: 'test' },
    order: purchaseOrder, sessionId: 'cs_1', onFailedAttempt: failed });
  return { session, intent, charge, stripe, run, failed };
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
  it.each(['wechat_pay', 'alipay'] as const)('recognizes current unpaid %s failure even when its failed charge says captured', async method => {
    const f = fixture(method);
    f.session.payment_status = 'unpaid';
    Object.assign(f.intent, { status: 'requires_payment_method', amount_received: 0,
      last_payment_error: { code: 'payment_intent_payment_attempt_failed' } });
    Object.assign(f.charge, { id: 'py_1', paid: false, status: 'failed', captured: true, amount_captured: 49600 });
    f.intent.latest_charge = 'py_1';
    await expect(f.run()).resolves.toBeNull();
    expect(f.failed).toHaveBeenCalledWith('pi_1');
    const noCharge = fixture(method); noCharge.session.payment_status = 'unpaid';
    Object.assign(noCharge.intent, { status: 'requires_payment_method', amount_received: 0, latest_charge: null,
      last_payment_error: { code: 'payment_intent_payment_attempt_failed' } });
    await expect(noCharge.run()).resolves.toBeNull(); expect(noCharge.failed).toHaveBeenCalledWith('pi_1');
  });
  it('does not call an unattempted, processing, canceled, or newly paid PI a failed attempt', async () => {
    for (const patch of [{ status: 'requires_payment_method', last_payment_error: null }, { status: 'processing' },
      { status: 'canceled' }, { status: 'succeeded', amount_received: 49600 }]) {
      const f = fixture(); f.session.payment_status = 'unpaid';
      Object.assign(f.intent, { status: 'requires_payment_method', amount_received: 0, latest_charge: null,
        last_payment_error: { code: 'payment_intent_payment_attempt_failed' } }, patch);
      await expect(f.run()).resolves.toBeNull(); expect(f.failed).not.toHaveBeenCalled();
    }
    const empty = fixture(); empty.session.payment_status = 'unpaid'; empty.session.payment_intent = null;
    await expect(empty.run()).resolves.toBeNull(); expect(empty.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
  it.each(['owner', 'amount', 'method', 'customer', 'mode', 'chargePaid', 'chargeOwner', 'chargeMethod', 'chargeAmount', 'chargeStatus'])(
    'rejects a failed attempt with conflicting %s', async reason => {
      const f = fixture(); f.session.payment_status = 'unpaid';
      Object.assign(f.intent, { status: 'requires_payment_method', amount_received: 0,
        last_payment_error: { code: 'payment_intent_payment_attempt_failed' } });
      Object.assign(f.charge, { paid: false, status: 'failed' });
      if (reason === 'owner') f.intent.metadata = { orderId: 'other', userId: order.user_id };
      if (reason === 'amount') f.intent.amount = 1;
      if (reason === 'method') f.intent.payment_method_types = ['card'];
      if (reason === 'customer') f.intent.customer = 'cus_other';
      if (reason === 'mode') f.intent.livemode = true;
      if (reason === 'chargePaid') f.charge.paid = true;
      if (reason === 'chargeOwner') f.charge.payment_intent = 'pi_other';
      if (reason === 'chargeMethod') f.charge.payment_method_details.type = 'card';
      if (reason === 'chargeAmount') f.charge.amount = 1;
      if (reason === 'chargeStatus') f.charge.status = 'succeeded';
      await expect(f.run()).rejects.toThrow(reason === 'amount' || reason === 'chargeAmount'
        ? 'PAY_COMMON_RECEIPT_MISMATCH' : 'PAY_WAFFO_PAYMENT_CONFLICT');
      expect(f.failed).not.toHaveBeenCalled();
    },
  );
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
  it.each([{ payment_channel: 'waffo' }, { merchant_namespace: 'other-account' }, { payment_mode: 'live' }])(
    'rejects persisted scope mismatch before querying Stripe', async change => {
      const f = fixture();
      await expect(readWalletPaymentEvidence({ stripe: f.stripe as unknown as Stripe,
        scope: { merchant: 'fixture', mode: 'test' }, order: { ...order, ...change }, sessionId: 'cs_1' })).rejects.toThrow();
      expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    },
  );
  it('R7: a live account accepts only live objects for a live order', async () => {
    const f = fixture();
    for (const value of [f.session, f.intent, f.charge]) value.livemode = true;
    const live = () => readWalletPaymentEvidence({ stripe: f.stripe as unknown as Stripe, scope: { merchant: 'fixture', mode: 'live' },
      order: { ...order, payment_mode: 'live' }, sessionId: 'cs_1' });
    expect((await live())?.paymentId).toBe('pi_1');
    f.charge.livemode = false; await expect(live()).rejects.toThrow();
  });
  it('propagates lookup timeout without interpreting it as unpaid', async () => {
    const f = fixture(); f.stripe.charges.retrieve.mockRejectedValue(new Error('timeout'));
    await expect(f.run()).rejects.toThrow('timeout');
  });
});
