/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), clock: vi.fn(), cash: vi.fn(), close: vi.fn(), tax: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./stripeTestClock', () => ({ observeStripeTestClock: mocks.clock }));
vi.mock('./stripeTestClockClose', () => ({ closeRefundedTestClockCheckout: mocks.close }));
vi.mock('./cardPaymentEvidence', () => ({ readCardPaymentEvidence: mocks.cash, recordCardPaymentTax: mocks.tax }));
import { recoverMethodCheckout } from './walletWebhook';
const ORDER = '00000000-0000-4000-8000-000000000001';
const SESSION = { id: 'cs_clock', object: 'checkout.session', status: 'complete', payment_status: 'paid',
  metadata: { orderId: ORDER, userId: 'owner' }, expires_at: 2000000000 };
function fixture() {
  const order = { id: ORDER, user_id: 'owner', payment_method: 'card', payment_channel: 'stripe', payment_mode: 'test',
    merchant_namespace: 'acct_fixture', item_type: 'membership_plan', price_ref_id: 'price_ref' };
  const rpc = vi.fn<(name: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>>()
    .mockResolvedValue({ data: null, error: null });
  const from = vi.fn((table: string) => {
    let kind = '';
    const q = { select: vi.fn(), eq: vi.fn((key: string, value: string) => { if (key === 'object_type') kind = value; return q; }),
      maybeSingle: vi.fn(async () => ({ data: table === 'payment_orders' ? order : kind === 'price' ? { external_id: 'price_pro' } : null, error: null })) };
    q.select.mockReturnValue(q); return q;
  });
  const db = { from, rpc } as unknown as SupabaseClient;
  const stripe = { checkout: { sessions: { retrieve: vi.fn(async () => SESSION) } } } as unknown as Stripe;
  return { rpc, db, stripe, run: () => recoverMethodCheckout(db, stripe, SESSION.id) };
}
describe('lost Checkout bind recovers a refunded first payment before closing it', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.scope.mockResolvedValue({ merchant: 'acct_fixture', mode: 'test' });
    mocks.clock.mockResolvedValue({ customerId: 'cus_clockfixture', clockId: 'clock_fixture', asOf: '2026-10-21T12:00:00Z' });
    mocks.cash.mockImplementation(async input => {
      input.onValidatedSession(SESSION);
      return { paymentId: 'in_first', checkoutId: SESSION.id, amount: 2900, tax: 0, currency: 'usd',
        paidAt: '2026-10-21T12:00:00Z', subscription: { id: 'sub_fixture', start: '2026-10-21T12:00:00Z', end: '2026-11-21T12:00:00Z' } };
    });
    mocks.close.mockResolvedValue(true);
  });
  it('authenticates the recovered session and first invoice, binds the original verified session, then closes without granting', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'paid' });
    expect(mocks.cash).toHaveBeenCalledOnce();
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('pay_waffo_bind_checkout', { p_user: 'owner', p_order: ORDER,
      p_merchant: 'acct_fixture', p_checkout: SESSION.id, p_expires: new Date(SESSION.expires_at * 1000).toISOString() });
    expect(mocks.cash.mock.invocationCallOrder[0]).toBeLessThan(f.rpc.mock.invocationCallOrder[0]!);
    expect(f.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]!);
    expect(mocks.tax).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalledWith('pay_dispute_fulfill', expect.anything());
  });
  it('keeps the order unresolved when original Checkout binding is refused; does not attempt close or fulfillment', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { message: 'PAY_WAFFO_BIND_DENIED' } });
    await expect(f.run()).rejects.toThrow('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    expect(mocks.cash).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledOnce(); expect(mocks.tax).not.toHaveBeenCalled();
  });
  it('never binds or closes a recovered session whose authoritative first-payment evidence is invalid', async () => {
    const f = fixture(); mocks.cash.mockRejectedValue(new Error('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'));
    await expect(f.run()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.tax).not.toHaveBeenCalled();
  });
});
