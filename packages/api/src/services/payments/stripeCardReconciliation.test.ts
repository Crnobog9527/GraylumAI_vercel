/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), ref: vi.fn(), recover: vi.fn(), invoice: vi.fn(), refund: vi.fn(),
  stripeId: vi.fn(), stop: vi.fn(), settle: vi.fn(), disputeRepair: vi.fn(), disputeRefundRepair: vi.fn() }));
vi.mock('./methodOrderSettle', () => ({ settleOpenMethodOrders: mocks.settle }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./stripeReferences', () => ({ findStripeReference: mocks.ref }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
vi.mock('./cardSubscriptionWebhook', () => ({ handleCardSubscriptionInvoice: mocks.invoice }));
vi.mock('./cardRefundWebhook', () => ({ handleCardRefund: mocks.refund }));
vi.mock('./cardUpgrade', () => ({ cardStripeSubscription: mocks.stripeId }));
vi.mock('./cardSubscriptionStop', () => ({ stopRenewalAfterReview: mocks.stop }));
vi.mock('./disputes', () => ({ reconcilePaymentDisputes: mocks.disputeRepair }));
vi.mock('./disputeRenewalRefund', () => ({ reconcileDisputeRenewalRefunds: mocks.disputeRefundRepair }));
import { reconcileStripeCardPayments } from './stripeCardReconciliation';

const ORDER = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-14T04:00:00.000Z');
type Order = { payment_channel: string; payment_method: string; fulfilled_at: string | null; method_review_reason: string | null;
  payment_amount_facts: Array<{ kind: string }> };

function fixture(state: { orders?: Record<string, Order>; sessions?: unknown[]; invoices?: unknown[]; refunds?: unknown[];
  recorded?: Set<string>; stopping?: string[] } = {}) {
  const orders = state.orders ?? {};
  const recorded = state.recorded ?? new Set<string>();
  mocks.ref.mockImplementation(async (_db: unknown, type: string, external: string) =>
    recorded.has(`${type}:${external}`) ? { order_id: ORDER } : undefined);
  const db = { from: vi.fn((table: string) => {
    let key = '', after = '';
    const chain = { select: vi.fn(() => chain), eq: vi.fn((_k: string, value: string) => { key = value; return chain; }),
      is: vi.fn(() => chain), not: vi.fn(() => chain), neq: vi.fn(() => chain), in: vi.fn(() => chain), order: vi.fn(() => chain),
      gt: vi.fn((_k: string, value: string) => { after = value; return chain; }),
      // Card subscriptions with a requested stop Stripe has not confirmed (scan 4), in id order after the cursor.
      limit: vi.fn(async (n: number) => ({ error: null, data: table === 'user_subscriptions'
        ? [...(state.stopping ?? [])].sort().filter(id => id > after).slice(0, n).map(id => ({ id })) : [] })),
      maybeSingle: vi.fn(async () => ({ error: null, data: orders[key] ?? null })) };
    return chain;
  }) };
  const page = (rows: unknown[] = []) => vi.fn(async () => ({ data: rows, has_more: false }));
  // Refund events carry the refund (or, for charge.refunded, the charge) as it was then; the scan re-reads it.
  const refundRows = (state.refunds ?? []) as Array<{ id: string; status: string; object?: string }>;
  const events = refundRows.map((row, i) => ({ id: `evt_${i}`, type: row.object === 'charge' ? 'charge.refunded' : 'refund.updated',
    data: { object: { object: 'refund', ...row } } }));
  const stripe = { checkout: { sessions: { list: page(state.sessions) } }, invoices: { list: page(state.invoices) },
    events: { list: page(events) }, refunds: { retrieve: vi.fn(async (refundId: string) => refundRows.find(row => row.id === refundId)) } };
  const run = (options: Record<string, unknown> = {}) => reconcileStripeCardPayments(db as unknown as SupabaseClient,
    stripe as unknown as Stripe, { expectedMode: 'test', now, ...options });
  return { db, stripe, orders, recorded, run };
}
const card = (patch: Partial<Order> = {}): Order => ({ payment_channel: 'stripe', payment_method: 'card', fulfilled_at: null,
  method_review_reason: null, payment_amount_facts: [{ kind: 'paid' }, { kind: 'tax' }], ...patch });
const session = (patch: Record<string, unknown> = {}) => ({ id: 'cs_1', payment_status: 'paid', metadata: { orderId: ORDER }, ...patch });

describe('PAY-STRIPE-MP daily Stripe card reconciliation', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    for (const mock of [mocks.recover, mocks.invoice, mocks.refund, mocks.stop]) mock.mockReset();
    mocks.settle.mockReset().mockResolvedValue({ checked: 0, repaired: 0, complete: true, findings: [] });
    mocks.disputeRepair.mockReset().mockResolvedValue({ checked: 0, failed: 0, complete: true });
    mocks.disputeRefundRepair.mockReset().mockResolvedValue({ checked: 0, failed: 0, complete: true });
    mocks.stripeId.mockReset().mockImplementation(async (_db: unknown, _scope: unknown, local: string) => `sub_${local}`);
  });
  it('retries a requested stop Stripe has not confirmed (an upgrade-replaced Pro) and reports one that still fails', async () => {
    mocks.stop.mockImplementation(async (_db: unknown, _stripe: unknown, _merchant: string, local: string) => {
      if (local === 'stuck') throw new Error('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
    });
    const f = fixture({ stopping: ['pro', 'stuck'] });
    const result = await f.run();
    expect(mocks.stop).toHaveBeenCalledWith(f.db, f.stripe, 'fixture', 'pro', 'sub_pro');
    expect(result).toMatchObject({ success: false, repaired: 1, findings: [{ kind: 'stop_unconfirmed', object: 'subscription',
      externalId: 'stuck', code: 'PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED' }] });
    // More than one page (after a Stripe outage): every pending stop is retried, page after page, even when the first
    // page keeps failing; beyond the page cap the scan is reported incomplete, never silently complete.
    mocks.stop.mockReset().mockImplementation(async (_db: unknown, _stripe: unknown, _merchant: string, local: string) => {
      if (local < 's050') throw new Error('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
    });
    const ids = Array.from({ length: 150 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    const many = await fixture({ stopping: ids }).run();
    expect(mocks.stop).toHaveBeenCalledTimes(150);
    expect(many).toMatchObject({ complete: true, repaired: 100 });
    expect(many.findings.filter(item => item.kind === 'stop_unconfirmed')).toHaveLength(50);
    mocks.stop.mockReset().mockResolvedValue(undefined);
    const capped = await fixture({ stopping: ids }).run({ maxPages: 1 });
    expect(mocks.stop).toHaveBeenCalledTimes(100);
    expect(capped).toMatchObject({ complete: false,
      findings: [{ kind: 'scan_incomplete', object: 'subscription', code: 'PENDING_STOPS_OVER_LIMIT' }] });
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
  it('runs dispute repair before budget-consuming history scans and skips them when the dispute budget is exhausted', async () => {
    const f = fixture({ sessions: [session()] });
    mocks.disputeRepair.mockImplementation(async () => ({ checked: 1, failed: 0, complete: false }));
    const result = await f.run({ budgetMs: -1 });
    expect(mocks.disputeRepair.mock.invocationCallOrder[0]).toBeLessThan(f.stripe.checkout.sessions.list.mock.invocationCallOrder[0] ?? Infinity);
    expect(mocks.disputeRefundRepair.mock.invocationCallOrder[0]).toBeLessThan(f.stripe.checkout.sessions.list.mock.invocationCallOrder[0] ?? Infinity);
    expect(f.stripe.checkout.sessions.list).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, complete: false, checked: 1,
      findings: [{ kind: 'scan_incomplete', code: 'PAY_DISPUTE_SCAN_INCOMPLETE' }] });
  });
  it('reserves at least ten seconds of the shared backstop for mandatory renewal refunds', async () => {
    const f = fixture();
    await expect(f.run({ budgetMs: 40_000 })).resolves.toMatchObject({ success: true });
    const disputeDeadline = mocks.disputeRepair.mock.calls[0]?.[3] as number;
    const refundDeadline = mocks.disputeRefundRepair.mock.calls[0]?.[3] as number;
    expect(refundDeadline - disputeDeadline).toBeGreaterThanOrEqual(10_000);
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
    // Replayed so the undelivered card subscription is stopped at Stripe even if its webhook gave up.
    expect(mocks.recover).toHaveBeenCalledWith(review.db, review.stripe, 'cs_1', 'checkout.session.completed');
    mocks.recover.mockReset();
    const stuck = fixture({ orders: { [ORDER]: card() }, sessions: [session()] });
    mocks.recover.mockResolvedValue({ orderId: ORDER });
    await expect(stuck.run()).resolves.toMatchObject({ findings: [{ kind: 'paid_not_delivered', externalId: 'cs_1' }] });
    mocks.recover.mockRejectedValue(new Error('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT'));
    await expect(stuck.run()).resolves.toMatchObject({ findings: [{ kind: 'repair_failed', object: 'checkout',
      code: 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT' }] });
  });
  it('replays a delivered payment whose tax fact is missing, so refunds can be judged against the charge', async () => {
    const f = fixture({ orders: { [ORDER]: card({ fulfilled_at: 'x', payment_amount_facts: [{ kind: 'paid' }] }) }, sessions: [session()] });
    mocks.recover.mockImplementation(async () => { f.orders[ORDER] = card({ fulfilled_at: 'x' }); return { orderId: ORDER }; });
    await expect(f.run()).resolves.toMatchObject({ success: true, repaired: 1 });
    const stuck = fixture({ orders: { [ORDER]: card({ fulfilled_at: 'x', payment_amount_facts: [{ kind: 'paid' }] }) }, sessions: [session()] });
    mocks.recover.mockResolvedValue({ orderId: ORDER });
    await expect(stuck.run()).resolves.toMatchObject({ findings: [{ kind: 'tax_not_recorded', object: 'checkout', orderId: ORDER }] });
  });
  it('records a paid renewal whose webhook was lost, and skips recorded or non-card invoices', async () => {
    const renewal = { id: 'in_cycle', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } };
    const f = fixture({ orders: { [ORDER]: card({ fulfilled_at: 'x' }) }, invoices: [renewal, { ...renewal, id: 'in_create', billing_reason: 'subscription_create' },
      { ...renewal, id: 'in_done' }, { ...renewal, id: 'in_legacy' }], recorded: new Set(['payment:in_done']) });
    mocks.invoice.mockImplementation(async (_db: unknown, _s: unknown, invoiceId: string) => {
      if (invoiceId === 'in_legacy') return false;
      f.recorded.add(`payment:${invoiceId}`); return true;
    });
    await expect(f.run()).resolves.toMatchObject({ success: true, repaired: 1 });
    expect(mocks.invoice.mock.calls.map(call => call[2])).toEqual(['in_cycle', 'in_legacy']);
    expect(mocks.invoice).toHaveBeenCalledWith(f.db, f.stripe, 'in_cycle', 'invoice.paid', undefined, undefined, undefined);
    // Recorded but without its tax fact: replayed through the idempotent renewal handler.
    const untaxed = fixture({ orders: { [ORDER]: card({ fulfilled_at: 'x', payment_amount_facts: [{ kind: 'paid' }] }) },
      invoices: [renewal], recorded: new Set(['payment:in_cycle']) });
    mocks.invoice.mockReset().mockImplementation(async () => { untaxed.orders[ORDER] = card({ fulfilled_at: 'x' }); return true; });
    await expect(untaxed.run()).resolves.toMatchObject({ success: true, repaired: 1 });
    // Kept for review (taxed): replayed so a confirmed stop and its alert are repeated, but not counted as a repair.
    const review = fixture({ orders: { [ORDER]: card({ method_review_reason: 'unexpected_renewal' }) }, invoices: [renewal],
      recorded: new Set(['payment:in_cycle']) });
    mocks.invoice.mockReset().mockResolvedValue(true);
    await expect(review.run()).resolves.toMatchObject({ success: true, repaired: 0 });
    expect(mocks.invoice).toHaveBeenCalledWith(review.db, review.stripe, 'in_cycle', 'invoice.paid', undefined, undefined, undefined);
  });
  it('recovers external and approved subscription refunds whose webhook was lost from the window events', async () => {
    // re_late was created long before the window and succeeded inside it: its refund.updated event is in the window.
    const f = fixture({ recorded: new Set(['refund:re_known']), refunds: [{ id: 're_known', status: 'succeeded', metadata: {} },
      { id: 're_late', status: 'succeeded', metadata: {} }, { id: 're_late', status: 'succeeded', metadata: {} },
      { id: 're_ours', status: 'succeeded', metadata: { refundIntentId: 'i' } }, { id: 're_failed', status: 'failed', metadata: {} },
      { id: 're_stuck', status: 'succeeded', metadata: {} }, { id: 'ch_1', status: 'succeeded', object: 'charge', metadata: {} }] });
    f.stripe.events.list.mockImplementation(async () => ({ has_more: false, data: [
      ...['re_known', 're_late', 're_late', 're_ours', 're_failed', 're_stuck'].map((id, i) => ({ id: `evt_${i}`, type: 'refund.updated',
        data: { object: { object: 'refund', id, metadata: id === 're_ours' ? { refundIntentId: 'i' } : {} } } })),
      { id: 'evt_charge', type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_1', metadata: {} } } }] }));
    mocks.refund.mockImplementation(async (_db: unknown, _s: unknown, input: { refundId?: string }) => {
      if (input.refundId === 're_late' || input.refundId === 're_ours') f.recorded.add(`refund:${input.refundId}`);
      return true;
    });
    await expect(f.run()).resolves.toMatchObject({ success: false, repaired: 2,
      findings: [{ kind: 'refund_not_recorded', object: 'refund', externalId: 're_stuck' }] });
    // Each refund once (re_late had two events); approved refunds are verified by their existing handler; the failed one is replayed but owes nothing;
    // a recorded refund is replayed (it may owe a review alert) but is not a repair; a charge event replays the charge.
    expect(mocks.refund.mock.calls.map(call => call[2])).toEqual([{ refundId: 're_known' }, { refundId: 're_late' },
      { refundId: 're_ours' }, { refundId: 're_failed' }, { refundId: 're_stuck' }, { chargeId: 'ch_1' }]);
    expect(f.stripe.events.list).toHaveBeenCalledWith({ created: { gte: 1791345600 }, limit: 100,
      types: ['refund.created', 'refund.updated', 'charge.refund.updated', 'charge.refunded'] });
  });
  it('pages through Stripe and reports an incomplete scan; a Stripe list error fails the scan', async () => {
    const f = fixture();
    mocks.refund.mockResolvedValue(false);
    f.stripe.events.list = vi.fn(async () => ({ data: [{ id: 'evt_x', type: 'refund.updated',
      data: { object: { object: 'refund', id: `re_${Math.random()}`, metadata: {} } } }], has_more: true }));
    await expect(f.run({ maxPages: 2 })).resolves.toMatchObject({ success: false, complete: false,
      findings: [{ kind: 'scan_incomplete', object: 'refund' }] });
    expect(f.stripe.events.list).toHaveBeenCalledTimes(2);
    expect(f.stripe.events.list).toHaveBeenLastCalledWith(expect.objectContaining({ starting_after: 'evt_x' }));
    // Past the time budget the scan stops (the cron must still return) and reports an incomplete scan.
    const slow = fixture({ sessions: [session(), session({ id: 'cs_2' })], invoices: [{ id: 'in_1' }] });
    await expect(slow.run({ budgetMs: -1 })).resolves.toMatchObject({ complete: false, checked: 0,
      findings: [{ kind: 'scan_incomplete', object: 'subscription', code: 'TIME_BUDGET' }] });
    expect(slow.stripe.invoices.list).not.toHaveBeenCalled();
    f.stripe.invoices.list = vi.fn(async () => { throw new Error('stripe down'); });
    await expect(f.run()).rejects.toThrow('stripe down');
  });
  it('#961: closes open unpaid orders that can no longer be paid (expired sessions are not in the paid scan)', async () => {
    mocks.settle.mockResolvedValue({ checked: 2, repaired: 1, complete: true,
      findings: [{ kind: 'open_order_unresolved', object: 'order', orderId: ORDER, code: 'PAY_WAFFO_CHECKOUT_UNAVAILABLE' }] });
    const f = fixture();
    const result = await f.run();
    expect(mocks.settle).toHaveBeenCalledWith(f.db, f.stripe, { mode: 'test', merchant: 'fixture' },
      expect.objectContaining({ now: now.getTime() / 1000, maxPages: 10 }));
    expect(result).toMatchObject({ success: false, complete: true, checked: 2, repaired: 1,
      findings: [{ kind: 'open_order_unresolved', orderId: ORDER }] });
    mocks.settle.mockResolvedValue({ checked: 0, repaired: 0, complete: false, findings: [{ kind: 'scan_incomplete', object: 'order' }] });
    await expect(fixture().run()).resolves.toMatchObject({ success: false, complete: false });
  });
});
