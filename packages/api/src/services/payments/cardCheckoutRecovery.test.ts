/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), card: vi.fn(), wallet: vi.fn(), stopPrior: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./cardPaymentEvidence', async importActual => ({ ...await importActual<typeof import('./cardPaymentEvidence')>(),
  readCardPaymentEvidence: mocks.card }));
vi.mock('./walletPaymentEvidence', () => ({ readWalletPaymentEvidence: mocks.wallet }));
vi.mock('./cardUpgrade', () => ({ stopPriorAfterUpgrade: mocks.stopPrior }));
import { recoverMethodCheckout } from './walletWebhook';

function fixture(overrides: Record<string, unknown> = {}) {
  const order = { id: 'order', user_id: 'user', payment_method: 'card', item_type: 'membership_plan', entitlement_term: 'month',
    price_ref_id: 'ref', merchant_namespace: 'fixture', ...overrides };
  const db = { rpc: vi.fn().mockResolvedValue({ data: { state: 'fulfilled' }, error: null }),
    from: vi.fn((table: string) => {
      const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn().mockResolvedValue({ error: null,
        data: table === 'payment_orders' ? order : { order_id: 'order', external_id: 'price_gold_month' } }) };
      return chain;
    }) };
  return { db, run: (eventType?: string) => recoverMethodCheckout(db as unknown as SupabaseClient, {} as Stripe, 'cs_card', eventType) };
}
describe('PAY-STRIPE-MP card first payment through the method recovery', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.wallet.mockReset();
    mocks.card.mockReset().mockResolvedValue({ paymentId: 'in_1', checkoutId: 'cs_card', amount: 4900, tax: 980, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscription: { id: 'sub_1', start: '2026-10-12T08:42:34.000Z', end: '2026-11-12T08:42:34.000Z' } });
  });
  it('fulfills a card subscription with the Stripe period, subscription id and pre-tax amount', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ orderId: 'order' });
    expect(mocks.card).toHaveBeenCalledWith(expect.objectContaining({ priceId: 'price_gold_month', sessionId: 'cs_card' }));
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_fulfill_payment', { p_order: 'order', p_merchant: 'fixture', p_checkout: 'cs_card',
      p_payment: 'in_1', p_amount: 4900, p_currency: 'usd', p_paid_at: '2026-10-12T08:42:40.000Z', p_subscription: 'sub_1',
      p_start: '2026-10-12T08:42:34.000Z', p_end: '2026-11-12T08:42:34.000Z' });
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
    await review.run();
    expect(mocks.stopPrior).toHaveBeenCalledTimes(1);
  });
  it('fulfills an international card pack as a one-time payment', async () => {
    mocks.card.mockResolvedValue({ paymentId: 'pi_1', checkoutId: 'cs_card', amount: 940, tax: 188, currency: 'usd',
      paidAt: '2026-10-12T08:42:40.000Z', subscription: null });
    const f = fixture({ item_type: 'credit_package' });
    await f.run();
    expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_fulfill_payment', expect.objectContaining({ p_payment: 'pi_1', p_amount: 940,
      p_subscription: null, p_start: null, p_end: null }));
    expect(f.db.rpc).toHaveBeenLastCalledWith('pay_stripe_mp_record_tax', expect.objectContaining({ p_payment: 'pi_1', p_tax: 188 }));
  });
  it('closes an expired or async-failed unpaid card checkout and releases the reservation; an open one is left alone', async () => {
    for (const [status, eventType, closes] of [['expired', 'checkout.session.expired', true],
      ['complete', 'checkout.session.async_payment_failed', true], ['open', undefined, false]] as const) {
      mocks.card.mockImplementation(async ({ onValidatedSession }) => {
        onValidatedSession?.({ status, payment_status: 'unpaid' }); return null;
      });
      const f = fixture({ payment_method: 'card_cn' });
      await expect(f.run(eventType)).resolves.toEqual({ orderId: 'order' });
      if (closes) {
        expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.objectContaining({ p_order: 'order',
          p_checkout: 'cs_card', p_state: 'closed_unpaid', p_amount: 0 }));
      } else expect(f.db.rpc).not.toHaveBeenCalled();
      expect(f.db.rpc).not.toHaveBeenCalledWith('pay_waffo_fulfill_payment', expect.anything());
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
