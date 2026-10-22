/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), card: vi.fn(), wallet: vi.fn(), stopPrior: vi.fn(), stopUndelivered: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./cardPaymentEvidence', async importActual => ({ ...await importActual<typeof import('./cardPaymentEvidence')>(),
  readCardPaymentEvidence: mocks.card }));
vi.mock('./walletPaymentEvidence', () => ({ readWalletPaymentEvidence: mocks.wallet }));
vi.mock('./cardUpgrade', () => ({ stopPriorAfterUpgrade: mocks.stopPrior }));
vi.mock('./cardSubscriptionStop', () => ({ stopUndeliveredSubscription: mocks.stopUndelivered }));
vi.mock('./disputePayment', () => ({ readDisputePayment: vi.fn(async () => ({ paymentIntentId: 'pi_fixture' })) }));
vi.mock('./disputes', () => ({ resumeOrderDisputes: vi.fn(async () => {}) }));
import { recoverMethodCheckout } from './walletWebhook';
import { syncMethodCheckoutReturn } from './methodCheckoutSync';

function fixture(overrides: Record<string, unknown> = {}) {
  const order = { id: 'order', user_id: 'user', payment_method: 'card', item_type: 'membership_plan', entitlement_term: 'month',
    price_ref_id: 'ref', merchant_namespace: 'fixture', payment_mode: 'test', fulfilled_at: null as string | null, ...overrides };
  const readOrder = vi.fn().mockImplementation(async () => ({ data: { ...order }, error: null }));
  const db = { rpc: vi.fn().mockResolvedValue({ data: { state: 'fulfilled' }, error: null }),
    from: vi.fn((table: string) => {
      const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
        maybeSingle: table === 'payment_orders' ? readOrder : vi.fn().mockResolvedValue({ error: null,
          data: { order_id: 'order', external_id: 'price_gold_month' } }) };
      return chain;
    }) };
  return { db, order, readOrder, returnToPage: () => syncMethodCheckoutReturn(db as unknown as SupabaseClient, {} as Stripe,
    { id: 'cs_card', mode: 'subscription', status: 'complete', payment_status: 'paid' } as Stripe.Checkout.Session, 'user'),
  run: (eventType?: string) => recoverMethodCheckout(db as unknown as SupabaseClient, {} as Stripe, 'cs_card', eventType) };
}
describe('PAY-STRIPE-MP card first payment through the method recovery', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.wallet.mockReset();
    mocks.stopPrior.mockReset().mockResolvedValue(undefined);
    mocks.stopUndelivered.mockReset().mockResolvedValue(undefined);
    mocks.card.mockReset().mockResolvedValue({ paymentId: 'in_1', checkoutId: 'cs_card', amount: 4900, tax: 980, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscription: { id: 'sub_1', start: '2026-10-12T08:42:34.000Z', end: '2026-11-12T08:42:34.000Z' } });
  });
  it('fulfills a card subscription with the Stripe period, subscription id and pre-tax amount', async () => {
    const f = fixture();
    // The recovery reports what it saw: a delivered payment is paid, whatever the caller's older session copy said.
    await expect(f.run()).resolves.toEqual({ orderId: 'order', checkoutStatus: null, paymentStatus: 'paid' });
    expect(mocks.card).toHaveBeenCalledWith(expect.objectContaining({ priceId: 'price_gold_month', sessionId: 'cs_card' }));
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(f.db.rpc).toHaveBeenCalledWith('pay_dispute_fulfill', { p_facts: { orderId: 'order', merchant: 'fixture',
      mode: 'test', checkoutId: 'cs_card', paymentId: 'in_1', paymentIntentId: 'pi_fixture', amount: 4900, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscriptionId: 'sub_1',
      start: '2026-10-12T08:42:34.000Z', end: '2026-11-12T08:42:34.000Z' } });
    // The tax Managed Payments added is recorded on the order as its own fact, after the payment itself.
    expect(f.db.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', { p_order: 'order', p_merchant: 'fixture',
      p_payment: 'in_1', p_tax: 980 });
  });
  it('stops the prior card subscription after a delivered upgrade, not after a payment kept for review', async () => {
    mocks.stopPrior.mockReset();
    const f = fixture({ method_transition: 'upgrade', method_prior_subscription: 'pro-sub' });
    await f.run();
    expect(mocks.stopPrior).toHaveBeenCalledWith(f.db, {}, expect.objectContaining({ method_transition: 'upgrade',
      method_prior_subscription: 'pro-sub' }));
    const review = fixture({ method_transition: 'upgrade', method_prior_subscription: 'pro-sub' });
    review.db.rpc.mockResolvedValue({ data: { state: 'review', reason: 'upgrade_payment_after_cutoff' }, error: null });
    mocks.stopUndelivered.mockReset();
    await review.run();
    expect(mocks.stopPrior).toHaveBeenCalledTimes(1);
    // Paid but kept for review: the prior Pro stays, and the new (undelivered) Gold subscription is stopped at Stripe.
    expect(mocks.stopUndelivered).toHaveBeenCalledWith({}, 'sub_1');
  });
  it.each(['card', 'card_cn'])('keeps renewal unchanged on repeated and concurrent fulfilled/refunded %s returns', async payment_method => {
    const f = fixture({ payment_method, status: 'refunded', payment_status: 'refunded', fulfilled_at: '2026-10-12T08:43:00Z' });
    f.db.rpc.mockResolvedValue({ data: { state: 'review', reason: 'refund_observed' }, error: null });
    await expect(f.returnToPage()).resolves.toMatchObject({ orderStatus: 'refunded', paymentStatus: 'paid',
      fulfilledAt: '2026-10-12T08:43:00Z' });
    await Promise.all([f.returnToPage(), f.returnToPage(), f.run('checkout.session.completed')]);
    expect(mocks.stopUndelivered).not.toHaveBeenCalled();
    expect(mocks.stopPrior).not.toHaveBeenCalled();
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_record_tax', expect.anything());
  });
  it('reads delivery after the atomic fulfillment result when delivery and refund raced the initial read', async () => {
    const f = fixture({ fulfilled_at: null });
    f.db.rpc.mockImplementation(async () => {
      f.order.fulfilled_at = '2026-10-12T08:43:00Z';
      return { data: { state: 'review', reason: 'refund_observed' }, error: null };
    });
    await f.run();
    expect(f.readOrder).toHaveBeenCalledTimes(2);
    expect(mocks.stopUndelivered).not.toHaveBeenCalled();
  });
  it.each(['read_failure', 'missing_order'])('does not stop renewal when refunded delivery cannot be confirmed: %s', async failure => {
    const f = fixture({ fulfilled_at: '2026-10-12T08:43:00Z' });
    f.db.rpc.mockResolvedValue({ data: { state: 'review', reason: 'refund_observed' }, error: null });
    f.readOrder.mockResolvedValueOnce({ data: f.order, error: null }).mockResolvedValueOnce({ data: null,
      error: failure === 'read_failure' ? { message: 'down' } : null });
    await expect(f.run()).rejects.toThrow('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
    expect(mocks.stopUndelivered).not.toHaveBeenCalled();
    expect(mocks.stopPrior).not.toHaveBeenCalled();
    // Failed stop decisions still do not skip independent tax bookkeeping.
    expect(f.db.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', expect.anything());
  });
  it('does not stop a delivered/refunded subscription even when tax bookkeeping fails', async () => {
    const f = fixture({ fulfilled_at: '2026-10-12T08:43:00Z' });
    f.db.rpc.mockImplementation(async (name: string) => name === 'pay_stripe_mp_record_tax'
      ? { data: null, error: { message: 'tax down' } }
      : { data: { state: 'review', reason: 'refund_observed' }, error: null });
    await expect(f.run()).rejects.toThrow();
    expect(mocks.stopUndelivered).not.toHaveBeenCalled();
  });
  it('still stops a never-delivered refunded subscription kept for review', async () => {
    const f = fixture({ fulfilled_at: null });
    f.db.rpc.mockResolvedValue({ data: { state: 'review', reason: 'refund_observed' }, error: null });
    await f.run();
    expect(mocks.stopUndelivered).toHaveBeenCalledExactlyOnceWith({}, 'sub_1');
  });
  it('still retries a failed never-delivered subscription stop', async () => {
    const f = fixture({ fulfilled_at: null });
    f.db.rpc.mockResolvedValue({ data: { state: 'review', reason: 'refund_observed' }, error: null });
    mocks.stopUndelivered.mockRejectedValueOnce(new Error('stripe down'));
    await expect(f.run()).rejects.toThrow('stripe down');
    await expect(f.run()).resolves.toMatchObject({ orderId: 'order', paymentStatus: 'paid' });
    expect(mocks.stopUndelivered).toHaveBeenCalledTimes(2);
  });
  it('stops the replaced Pro even when recording the tax fails, and records the tax even when the stop fails', async () => {
    mocks.stopPrior.mockReset();
    const taxDown = fixture({ method_transition: 'upgrade', method_prior_subscription: 'pro-sub' });
    taxDown.db.rpc.mockImplementation(async (name: string) => name === 'pay_stripe_mp_record_tax'
      ? { data: null, error: { message: 'down' } } : { data: { state: 'fulfilled' }, error: null });
    await expect(taxDown.run()).rejects.toThrow();
    expect(mocks.stopPrior).toHaveBeenCalledTimes(1);
    const stopDown = fixture({ method_transition: 'upgrade', method_prior_subscription: 'pro-sub' });
    mocks.stopPrior.mockRejectedValueOnce(new Error('stripe down'));
    await expect(stopDown.run()).rejects.toThrow('stripe down');
    expect(stopDown.db.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', expect.objectContaining({ p_order: 'order' }));
  });
  it('fulfills an international card pack as a one-time payment', async () => {
    mocks.card.mockResolvedValue({ paymentId: 'pi_1', checkoutId: 'cs_card', amount: 940, tax: 188, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscription: null });
    const f = fixture({ item_type: 'credit_package' });
    await f.run();
    expect(f.db.rpc).toHaveBeenCalledWith('pay_dispute_fulfill', expect.objectContaining({ p_facts: expect.objectContaining({ paymentId: 'pi_1', amount: 940,
      subscriptionId: null, start: null, end: null }) }));
    expect(f.db.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', expect.objectContaining({ p_payment: 'pi_1', p_tax: 188 }));
  });
  it('closes an expired or async-failed unpaid card checkout and releases the reservation; an open one is left alone', async () => {
    for (const [status, eventType, closes] of [['expired', 'checkout.session.expired', true],
      ['complete', 'checkout.session.async_payment_failed', true], ['open', undefined, false]] as const) {
      mocks.card.mockImplementation(async ({ onValidatedSession }) => {
        onValidatedSession?.({ status, payment_status: 'unpaid' }); return null;
      });
      const f = fixture({ payment_method: 'card_cn' });
      await expect(f.run(eventType)).resolves.toEqual({ orderId: 'order', checkoutStatus: status, paymentStatus: 'unpaid' });
      if (closes) {
        expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.objectContaining({ p_order: 'order',
          p_checkout: 'cs_card', p_state: 'closed_unpaid', p_amount: 0 }));
      } else expect(f.db.rpc).not.toHaveBeenCalled();
      expect(f.db.rpc).not.toHaveBeenCalledWith('pay_dispute_fulfill', expect.anything());
    }
  });
  it('propagates evidence failures without granting', async () => {
    mocks.card.mockRejectedValue(new Error('PAY_WAFFO_PAYMENT_CONFLICT'));
    const f = fixture();
    await expect(f.run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    expect(f.db.rpc).not.toHaveBeenCalled();
  });
  it('leaves legacy orders to the legacy path', async () => {
    await expect(fixture({ payment_method: null }).run()).resolves.toBeNull();
  });
});
