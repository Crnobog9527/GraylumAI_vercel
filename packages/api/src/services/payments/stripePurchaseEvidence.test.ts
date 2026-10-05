/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { assertStripePurchasePrice, closeExpiredStripeCheckout } from './stripePurchaseEvidence';

const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const snapshot = { version: 1, item_type: 'credit_package', item_id: '11111111-1111-4111-8111-111111111111',
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'one_time', currency: 'usd', unit: 'major',
  price: '19.99', discount: '2.00', tax_behavior: 'unspecified', credits: 100, bonus_credits: 20 };
const price = { id: 'price_fixture', object: 'price', active: true, livemode: false, currency: 'usd',
  unit_amount: 1999, billing_scheme: 'per_unit', type: 'one_time', recurring: null, tax_behavior: 'unspecified' } as Stripe.Price;
const order = { id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333',
  payment_channel: 'stripe', merchant_namespace: scope.merchant, payment_mode: scope.mode, purchase_snapshot: snapshot };
const session = { id: 'cs_test_fixture', object: 'checkout.session', status: 'expired', payment_status: 'unpaid',
  client_reference_id: order.user_id, metadata: { orderId: order.id, userId: order.user_id },
  payment_intent: null, subscription: null, amount_total: 1799, currency: 'usd', livemode: false, mode: 'payment' };

describe('authoritative Stripe purchase evidence', () => {
  it('validates list price rather than comparing the provider list price with discounted paid amount', () => {
    expect(assertStripePurchasePrice({ price, priceId: price.id, snapshot, scope })).toBe(price);
  });
  it.each([{ id: 'price_other' }, { unit_amount: 1799 }, { unit_amount: null }, { currency: 'eur' },
    { livemode: true }, { active: false }, { type: 'recurring' }, { billing_scheme: 'tiered' },
    { transform_quantity: { divide_by: 2, round: 'up' } }, { tax_behavior: 'exclusive' }])('rejects price mismatch %j', patch => {
    expect(() => assertStripePurchasePrice({ price: { ...price, ...patch } as Stripe.Price,
      priceId: price.id, snapshot, scope })).toThrow('PAY_COMMON_PRICE_MISMATCH');
  });
  it('checks recurring interval/count/type against the frozen contract', () => {
    const annual = { ...snapshot, item_type: 'membership_plan', billing_cycle: 'yearly' };
    const recurring = { ...price, type: 'recurring', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } };
    expect(() => assertStripePurchasePrice({ price: recurring as Stripe.Price, priceId: price.id, snapshot: annual, scope })).not.toThrow();
    expect(() => assertStripePurchasePrice({ price: { ...recurring, recurring: { ...recurring.recurring, interval_count: 2 } } as Stripe.Price,
      priceId: price.id, snapshot: annual, scope })).toThrow();
  });
  function fixture(value: unknown = session) {
    const retrieve = vi.fn().mockResolvedValue(value);
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    return { retrieve, rpc, args: { stripe: { checkout: { sessions: { retrieve } } } as unknown as Pick<Stripe, 'checkout' | 'paymentIntents' | 'charges'>,
      supabase: { rpc }, order, mappedSessionId: session.id, scope } };
  }
  it('retrieves the mapped session and closes only after verified expiry', async () => {
    const test = fixture();
    await expect(closeExpiredStripeCheckout(test.args)).resolves.toBe(true);
    expect(test.retrieve).toHaveBeenCalledWith(session.id);
    expect(test.rpc).toHaveBeenCalledWith('pay_common_close_checkout', expect.objectContaining({
      p_session_id: session.id, p_checkout_status: 'expired', p_payment_status: 'unpaid', p_order_id: order.id,
    }));
  });
  it.each([{ status: 'open' }, { status: 'complete' }, { payment_status: 'paid' }, { amount_total: 1900 },
    { livemode: true }, { payment_intent: 'pi_fixture' }, { subscription: 'sub_fixture' },
    { metadata: { orderId: 'other', userId: order.user_id } }, { client_reference_id: 'other' }])('retains identity for nonterminal/conflicting evidence %j', async patch => {
    const test = fixture({ ...session, ...patch });
    await expect(closeExpiredStripeCheckout(test.args)).rejects.toThrow();
    expect(test.rpc).not.toHaveBeenCalled();
  });
  it('does not close after a network timeout or scope mismatch', async () => {
    const test = fixture();
    test.retrieve.mockRejectedValue(new Error('timeout'));
    await expect(closeExpiredStripeCheckout(test.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_EVIDENCE_UNAVAILABLE');
    expect(test.rpc).not.toHaveBeenCalled();
    await expect(closeExpiredStripeCheckout({ ...test.args, scope: { ...scope, merchant: 'acct_other' } })).rejects.toThrow();
    expect(test.retrieve).toHaveBeenCalledTimes(1);
  });
});
