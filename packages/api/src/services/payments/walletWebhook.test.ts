/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), cash: vi.fn(), report: vi.fn(), stopPrior: vi.fn() }));
vi.mock('../analytics/gaPurchase', () => ({ reportGaPurchase: mocks.report }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./walletPaymentEvidence', () => ({ readWalletPaymentEvidence: mocks.cash }));
vi.mock('./cardUpgrade', () => ({ stopPriorAfterUpgrade: mocks.stopPrior }));
vi.mock('./disputePayment', () => ({ readDisputePayment: vi.fn(async () => ({ paymentIntentId: 'pi_fixture',
 chargeId: 'ch_fixture', invoiceId: 'in_1', subscriptionId: 'sub_1', paymentAt: '2026-10-18T00:00:00Z' })) }));
vi.mock('./disputes', () => ({ resumeOrderDisputes: vi.fn(async () => {}) }));
vi.mock('./disputeRenewalRefund', () => ({ refundDisputedRenewal: vi.fn(async () => 'succeeded') }));
import { recoverWalletCheckout } from './walletWebhook';
function fixture(overrides = {}) {
  const order = { referenceMissing: false, orderMissing: false, id: 'order', user_id: 'user', payment_method: 'alipay', item_type: 'membership_plan',
    entitlement_term: 'month', payment_mode: 'test', ...overrides };
  const db = { rpc: vi.fn().mockResolvedValue({ data: { state: 'fulfilled' }, error: null }),
    from: vi.fn((table: string) => {
      const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
        maybeSingle: vi.fn().mockResolvedValue({ data: table === 'payment_orders' ? order.orderMissing ? null : order
          : order.referenceMissing ? null : { order_id: 'order' }, error: null }) };
      return chain;
    }) };
  return { db, run: (stripe = {} as Stripe, eventType?: string) => recoverWalletCheckout(db as unknown as SupabaseClient, stripe, 'cs_wallet', eventType) };
}
describe('wallet callback/recovery', () => {
  beforeEach(() => {
    mocks.report.mockReset();
    mocks.stopPrior.mockReset().mockResolvedValue(undefined);
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    mocks.cash.mockReset().mockResolvedValue({ paymentId: 'pi_1', checkoutId: 'cs_wallet', amount: 6900,
      currency: 'usd', paidAt: '2028-01-31T00:00:00.000Z' });
  });
  it('uses verified payment time with leap-year month clamping', async () => {
    const f = fixture(); expect(await f.run()).toBe(true);
    expect(f.db.rpc).toHaveBeenCalledWith('pay_dispute_fulfill', expect.objectContaining({ p_facts: expect.objectContaining({
      orderId: 'order', start: '2028-01-31T00:00:00.000Z', end: '2028-02-29T00:00:00.000Z', paymentId: 'pi_1',
    }) }));
  });
  it('reports the GA purchase only from the call that newly delivered the order (ANALYTICS 0280)', async () => {
    mocks.report.mockReset().mockResolvedValue(true);
    const first = fixture(); first.db.rpc.mockResolvedValue({ data: { state: 'fulfilled', duplicate: false }, error: null });
    expect(await first.run()).toBe(true);
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith(first.db, expect.objectContaining({ id: 'order' }));
    for (const data of [{ state: 'fulfilled', duplicate: true }, { state: 'fulfilled' }, { state: 'review', reason: 'account_closed' }]) {
      const replay = fixture(); replay.db.rpc.mockResolvedValue({ data, error: null });
      await replay.run();
    }
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
  it('keeps the prior plan when fulfillment commits under a dispute freeze', async () => {
    const f = fixture();
    f.db.rpc.mockResolvedValue({ data: { state: 'fulfilled', duplicate: false, disputeFrozen: true }, error: null });
    await expect(f.run()).resolves.toBe(true);
    const { resumeOrderDisputes } = await import('./disputes');
    expect(resumeOrderDisputes).toHaveBeenCalled();
    expect(mocks.stopPrior).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('does not grant for pending, timeout, live, or unimplemented transitions', async () => {
    const f = fixture(); mocks.cash.mockResolvedValue(null); expect(await f.run()).toBe(true);
    expect(f.db.rpc).not.toHaveBeenCalled();
    mocks.cash.mockRejectedValue(new Error('timeout')); await expect(f.run()).rejects.toThrow('timeout');
    expect(f.db.rpc).not.toHaveBeenCalled();
    // R7: a test order never settles through the live account, and the reverse.
    mocks.scope.mockResolvedValue({ mode: 'live', merchant: 'fixture' }); await expect(f.run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    mocks.scope.mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    await expect(fixture({ payment_mode: 'live' }).run()).rejects.toThrow('PAY_WAFFO_PAYMENT_CONFLICT');
    expect(f.db.rpc).not.toHaveBeenCalled();
  });
  it('R7: a live order settles through the live account in live mode', async () => {
    mocks.scope.mockResolvedValue({ mode: 'live', merchant: 'fixture' });
    const f = fixture({ payment_mode: 'live' }); expect(await f.run()).toBe(true);
    expect(mocks.cash).toHaveBeenCalledWith(expect.objectContaining({ scope: { mode: 'live', merchant: 'fixture' } }));
    expect(f.db.rpc).toHaveBeenCalledWith('pay_dispute_fulfill', expect.objectContaining({ p_facts: expect.objectContaining({ orderId: 'order' }) }));
  });
  it('recovers a successful provider session when the original mapping write was lost', async () => {
    const originalId = '00000000-0000-4000-8000-000000000001';
    const f = fixture({ id: originalId, referenceMissing: true });
    const stripe = { checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ id: 'cs_wallet', object: 'checkout.session',
      metadata: { orderId: originalId }, expires_at: 2000000000 }) } } } as unknown as Stripe;
    expect(await f.run(stripe)).toBe(true);
    expect(f.db.rpc.mock.calls[0]).toEqual(['pay_waffo_bind_checkout', expect.objectContaining({ p_order: originalId, p_checkout: 'cs_wallet' })]);
    expect(f.db.rpc.mock.calls[1]?.[0]).toBe('pay_dispute_fulfill');
  });
  it('acknowledges an unpaid session that is not ours (no order, or an order this database never had)', async () => {
    const session = (metadata: Record<string, string>, payment_status = 'unpaid') => ({ checkout: { sessions: { retrieve: vi.fn()
      .mockResolvedValue({ id: 'cs_wallet', object: 'checkout.session', status: 'expired', mode: 'payment', payment_status, metadata }) } } }) as unknown as Stripe;
    const foreign = fixture({ referenceMissing: true, orderMissing: true });
    expect(await foreign.run(session({ mp_probe: '20261012' }))).toBe(true);
    expect(await foreign.run(session({ orderId: '00000000-0000-4000-8000-00000000dead' }))).toBe(true);
    expect(foreign.db.rpc).not.toHaveBeenCalled(); expect(mocks.cash).not.toHaveBeenCalled();
    // Paid money is never silently dropped: no order id falls back to the legacy path, an unknown order fails.
    expect(await foreign.run(session({}, 'paid'))).toBe(false);
    await expect(foreign.run(session({ orderId: '00000000-0000-4000-8000-00000000dead' }, 'paid')))
      .rejects.toThrow('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
    // A mapped session whose order disappeared is corruption, not a foreign session.
    await expect(fixture({ orderMissing: true }).run()).rejects.toThrow('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
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
  it('releases a complete/unpaid session only for the verified asynchronous failure event', async () => {
    mocks.cash.mockImplementation(async (input) => {
      input.onValidatedSession({ status: 'complete', payment_status: 'unpaid' }); return null;
    });
    const f = fixture();
    await f.run(); expect(f.db.rpc).not.toHaveBeenCalled();
    await f.run({} as Stripe, 'checkout.session.completed'); expect(f.db.rpc).not.toHaveBeenCalled();
    await f.run({} as Stripe, 'checkout.session.async_payment_failed');
    expect(f.db.rpc).toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.objectContaining({ p_state: 'closed_unpaid' }));
  });
  it('does not let a late failure event undo a verified successful payment', async () => {
    const f = fixture(); await f.run({} as Stripe, 'checkout.session.async_payment_failed');
    expect(f.db.rpc).toHaveBeenCalledWith('pay_dispute_fulfill', expect.anything());
    expect(f.db.rpc).not.toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.anything());
  });
  it('leaves legacy orders to their existing handler', async () => {
    const f = fixture({ payment_method: null }); expect(await f.run()).toBe(false);
    expect(mocks.cash).not.toHaveBeenCalled(); expect(f.db.rpc).not.toHaveBeenCalled();
  });
});
