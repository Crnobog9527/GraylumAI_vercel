/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), ref: vi.fn(), recover: vi.fn(), invoice: vi.fn(), refund: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./stripeReferences', () => ({ findStripeReference: mocks.ref }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
vi.mock('./cardSubscriptionWebhook', () => ({ handleCardSubscriptionInvoice: mocks.invoice }));
vi.mock('./cardRefundWebhook', () => ({ handleCardRefund: mocks.refund }));
import { reconcileStripeCardPayments } from './stripeCardReconciliation';

const ORDER = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-14T04:00:00.000Z');
type Order = { payment_channel: string; payment_method: string; fulfilled_at: string | null; method_review_reason: string | null };

function fixture(state: { orders?: Record<string, Order>; sessions?: unknown[]; invoices?: unknown[]; refunds?: unknown[];
  recorded?: Set<string> } = {}) {
  const orders = state.orders ?? {};
  const recorded = state.recorded ?? new Set<string>();
  mocks.ref.mockImplementation(async (_db: unknown, type: string, external: string) =>
    recorded.has(`${type}:${external}`) ? { order_id: ORDER } : undefined);
  const db = { from: vi.fn(() => {
    let key = '';
    const chain = { select: vi.fn(() => chain), eq: vi.fn((_k: string, value: string) => { key = value; return chain; }),
      maybeSingle: vi.fn(async () => ({ error: null, data: orders[key] ?? null })) };
    return chain;
  }) };
  const page = (rows: unknown[] = []) => vi.fn(async () => ({ data: rows, has_more: false }));
  const stripe = { checkout: { sessions: { list: page(state.sessions) } }, invoices: { list: page(state.invoices) },
    refunds: { list: page(state.refunds) } };
  const run = (options: Record<string, unknown> = {}) => reconcileStripeCardPayments(db as unknown as SupabaseClient,
    stripe as unknown as Stripe, { expectedMode: 'test', now, ...options });
  return { db, stripe, orders, recorded, run };
}
const card = (patch: Partial<Order> = {}): Order => ({ payment_channel: 'stripe', payment_method: 'card', fulfilled_at: null,
  method_review_reason: null, ...patch });
const session = (patch: Record<string, unknown> = {}) => ({ id: 'cs_1', payment_status: 'paid', metadata: { orderId: ORDER }, ...patch });

describe('PAY-STRIPE-MP daily Stripe card reconciliation', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    for (const mock of [mocks.recover, mocks.invoice, mocks.refund]) mock.mockReset();
  });
  it('runs in the mode the environment configures and refuses a key of the other mode', async () => {
    mocks.scope.mockResolvedValue({ mode: 'live', merchant: 'fixture' });
    const f = fixture({ sessions: [session()] });
    await expect(f.run()).rejects.toThrow('PAY_STRIPE_MP_RECONCILIATION_MODE_MISMATCH');
    expect(f.stripe.checkout.sessions.list).not.toHaveBeenCalled();
    await expect(f.run({ expectedMode: 'live' })).resolves.toMatchObject({ success: true });
    expect(f.stripe.checkout.sessions.list).toHaveBeenCalled();
    mocks.scope.mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    await expect(f.run({ expectedMode: 'live' })).rejects.toThrow('MODE_MISMATCH');
  });
  it('delivers a paid card checkout whose webhook was lost, through the same first-payment recovery', async () => {
    const f = fixture({ orders: { [ORDER]: card() }, sessions: [session()] });
    mocks.recover.mockImplementation(async () => { f.orders[ORDER] = card({ fulfilled_at: '2026-10-14T04:00:01.000Z' }); return { orderId: ORDER }; });
    await expect(f.run()).resolves.toMatchObject({ success: true, repaired: 1, findings: [] });
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_1', 'checkout.session.completed');
    expect(f.stripe.checkout.sessions.list).toHaveBeenCalledWith({ created: { gte: 1791345600 }, status: 'complete', limit: 100 });
  });
  it('leaves delivered, unpaid, wallet and unknown sessions alone; reports review and undeliverable ones', async () => {
    const other = '00000000-0000-4000-8000-000000000002';
    const f = fixture({ orders: { [ORDER]: card({ fulfilled_at: 'x' }), [other]: card({ payment_method: 'alipay' }) },
      sessions: [session(), session({ id: 'cs_unpaid', payment_status: 'unpaid' }), session({ id: 'cs_wallet', metadata: { orderId: other } }),
        session({ id: 'cs_foreign', metadata: {} })] });
    await expect(f.run()).resolves.toMatchObject({ success: true, repaired: 0 });
    expect(mocks.recover).not.toHaveBeenCalled();
    const review = fixture({ orders: { [ORDER]: card({ method_review_reason: 'founder_released' }) }, sessions: [session()] });
    await expect(review.run()).resolves.toMatchObject({ success: false,
      findings: [{ kind: 'paid_in_review', object: 'checkout', externalId: 'cs_1', orderId: ORDER }] });
    const stuck = fixture({ orders: { [ORDER]: card() }, sessions: [session()] });
    mocks.recover.mockResolvedValue({ orderId: ORDER });
    await expect(stuck.run()).resolves.toMatchObject({ findings: [{ kind: 'paid_not_delivered', externalId: 'cs_1' }] });
    mocks.recover.mockRejectedValue(new Error('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'));
    await expect(stuck.run()).resolves.toMatchObject({ findings: [{ kind: 'repair_failed', object: 'checkout',
      code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT' }] });
  });
  it('records a paid renewal whose webhook was lost, and skips recorded or non-card invoices', async () => {
    const renewal = { id: 'in_cycle', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } };
    const f = fixture({ invoices: [renewal, { ...renewal, id: 'in_create', billing_reason: 'subscription_create' },
      { ...renewal, id: 'in_done' }, { ...renewal, id: 'in_legacy' }], recorded: new Set(['payment:in_done']) });
    mocks.invoice.mockImplementation(async (_db: unknown, _s: unknown, invoiceId: string) => {
      if (invoiceId === 'in_legacy') return false;
      f.recorded.add(`payment:${invoiceId}`); return true;
    });
    await expect(f.run()).resolves.toMatchObject({ success: true, repaired: 1 });
    expect(mocks.invoice.mock.calls.map(call => call[2])).toEqual(['in_cycle', 'in_legacy']);
    expect(mocks.invoice).toHaveBeenCalledWith(f.db, f.stripe, 'in_cycle', 'invoice.paid', undefined, undefined);
  });
  it('records an external refund whose webhook was lost; ours and failed refunds are skipped', async () => {
    const f = fixture({ refunds: [{ id: 're_lost', status: 'succeeded', metadata: {} },
      { id: 're_ours', status: 'succeeded', metadata: { refundIntentId: 'i' } }, { id: 're_failed', status: 'failed', metadata: {} },
      { id: 're_stuck', status: 'succeeded', metadata: {} }] });
    mocks.refund.mockImplementation(async (_db: unknown, _s: unknown, input: { refundId: string }) => {
      if (input.refundId === 're_lost') f.recorded.add('refund:re_lost');
      return true;
    });
    await expect(f.run()).resolves.toMatchObject({ success: false, repaired: 1,
      findings: [{ kind: 'refund_not_recorded', object: 'refund', externalId: 're_stuck' }] });
    expect(mocks.refund.mock.calls.map(call => call[2])).toEqual([{ refundId: 're_lost' }, { refundId: 're_stuck' }]);
  });
  it('pages through Stripe and reports an incomplete scan; a Stripe list error fails the scan', async () => {
    const f = fixture();
    f.stripe.refunds.list = vi.fn(async () => ({ data: [{ id: 're_x', status: 'failed', metadata: {} }], has_more: true }));
    await expect(f.run({ maxPages: 2 })).resolves.toMatchObject({ success: false, complete: false,
      findings: [{ kind: 'scan_incomplete', object: 'refund' }] });
    expect(f.stripe.refunds.list).toHaveBeenCalledTimes(2);
    expect(f.stripe.refunds.list).toHaveBeenLastCalledWith({ created: { gte: 1791345600 }, limit: 100, starting_after: 're_x' });
    f.stripe.invoices.list = vi.fn(async () => { throw new Error('stripe down'); });
    await expect(f.run()).rejects.toThrow('stripe down');
  });
});
