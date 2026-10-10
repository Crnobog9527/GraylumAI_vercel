/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), cash: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletPaymentEvidence', () => ({ readWalletPaymentEvidence: mocks.cash }));
import { recoverWalletCheckout } from './walletWebhook';
function fixture(overrides = {}) {
  const order = { referenceMissing: false, id: 'order', user_id: 'user', payment_method: 'alipay', item_type: 'membership_plan',
    entitlement_term: 'month', ...overrides };
  const db = { rpc: vi.fn().mockResolvedValue({ data: { state: 'fulfilled' }, error: null }),
    from: vi.fn((table: string) => {
      const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
        maybeSingle: vi.fn().mockResolvedValue({ data: table === 'payment_orders' ? order : order.referenceMissing ? null : { order_id: 'order' }, error: null }) };
      return chain;
    }) };
  return { db, run: (stripe = {} as Stripe) => recoverWalletCheckout(db as unknown as SupabaseClient, stripe, 'cs_wallet') };
}
describe('wallet callback/recovery', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.cash.mockReset().mockResolvedValue({ paymentId: 'pi_1', checkoutId: 'cs_wallet', amount: 6900,
      currency: 'usd', paidAt: '2028-01-31T00:00:00.000Z' });
  });
  it('uses verified payment time with leap-year month clamping', async () => {
    const f = fixture(); expect(await f.run()).toBe(true);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_fulfill_payment', expect.objectContaining({
      p_order: 'order', p_start: '2028-01-31T00:00:00.000Z', p_end: '2028-02-29T00:00:00.000Z', p_payment: 'pi_1',
    }));
  });
  it('does not grant for pending, timeout, live, or unimplemented transitions', async () => {
    const f = fixture(); mocks.cash.mockResolvedValue(null); expect(await f.run()).toBe(true);
    expect(f.db.rpc).not.toHaveBeenCalled();
    mocks.cash.mockRejectedValue(new Error('timeout')); await expect(f.run()).rejects.toThrow('timeout');
    expect(f.db.rpc).not.toHaveBeenCalled();
    mocks.scope.mockResolvedValue({ mode: 'live', merchant: 'fixture' }); await expect(f.run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
  });
  it('recovers a successful provider session when the original mapping write was lost', async () => {
    const originalId = '00000000-0000-4000-8000-000000000001';
    const f = fixture({ id: originalId, referenceMissing: true });
    const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ id: 'cs_wallet', object: 'checkout.session',
      metadata: { orderId: originalId }, expires_at: 2000000000 }) } } } as unknown as Stripe;
    expect(await f.run(stripe)).toBe(true);
    expect(f.db.rpc.mock.calls[0]).toEqual(['pay_waffo_bind_checkout', expect.objectContaining({ p_order: originalId, p_checkout: 'cs_wallet' })]);
    expect(f.db.rpc.mock.calls[1]?.[0]).toBe('pay_waffo_fulfill_payment');
  });
  it('releases reservations only after validated original session is expired and unpaid', async () => {
    mocks.cash.mockImplementation(async (input) => {
      input.onValidatedSession({ status: 'expired', payment_status: 'unpaid' }); return null;
    });
    const f = fixture(); expect(await f.run()).toBe(true);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.objectContaining({
      p_state: 'closed_unpaid', p_checkout: 'cs_wallet', p_payment: null, p_amount: 0,
    }));
  });
  it('leaves legacy orders to their existing handler', async () => {
    const f = fixture({ payment_method: null }); expect(await f.run()).toBe(false);
    expect(mocks.cash).not.toHaveBeenCalled(); expect(f.db.rpc).not.toHaveBeenCalled();
  });
});
