/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('./walletWebhook', () => ({ recoverMethodCheckout: mocks.recover }));
import { settleBuyerOrders, settleMethodOrder, settleOpenMethodOrders } from './methodOrderSettle';

const ORDER = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const scope = { merchant: 'fixture', mode: 'test' as const };
const NOW = Date.parse('2026-10-16T04:00:00.000Z') / 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
type Row = { id: string; user_id: string; created_at: string; method_dispatched_at: string | null;
  method_checkout_expires_at: string | null };
const order = (patch: Partial<Row> = {}): Row => ({ id: ORDER, user_id: USER, created_at: iso(NOW - 7200),
  method_dispatched_at: iso(NOW - 7200), method_checkout_expires_at: iso(NOW - 7200 + 1860), ...patch });

function fixture(state: { bound?: string | null; sessions?: Array<{ id: string; metadata: Record<string, string> }>;
  rows?: Row[]; closeError?: string; listHasMore?: boolean; failedEvents?: string[] } = {}) {
  const filters: Array<[string, string, unknown]> = [];
  const rpc = vi.fn(async () => state.closeError ? { data: null, error: { message: state.closeError } } : { data: null, error: null });
  const db = { rpc, from: vi.fn((table: string) => {
    let after = '';
    const record = (op: string) => (key: string, value: unknown) => {
      filters.push([op, key, value]); if (op === 'gt' && key === 'id') after = value as string; return chain;
    };
    const chain = { select: vi.fn(() => chain), eq: vi.fn(record('eq')), in: vi.fn(record('in')), is: vi.fn(record('is')),
      lt: vi.fn(record('lt')), gt: vi.fn(record('gt')), order: vi.fn(() => chain),
      limit: vi.fn(async (n: number) => ({ error: null, data: table === 'payment_orders'
        ? (state.rows ?? []).filter(row => row.id > after).slice(0, n) : [] })),
      maybeSingle: vi.fn(async () => ({ error: null, data: state.bound ? { external_id: state.bound } : null })) };
    return chain;
  }) };
  const list = vi.fn(async () => ({ data: state.sessions ?? [], has_more: state.listHasMore ?? false }));
  // Stripe's own async-payment-failed events, read back through the API (the webhook may have been lost).
  const events = vi.fn(async () => ({ has_more: false, data: (state.failedEvents ?? []).map((session, i) => ({ id: `evt_${i}`,
    type: 'checkout.session.async_payment_failed', data: { object: { object: 'checkout.session', id: session } } })) }));
  const stripe = { checkout: { sessions: { list, retrieve: vi.fn(async (sessionId: string) => ({ id: sessionId })) } },
    events: { list: events } };
  return { db: db as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, rpc, list, events, filters };
}

describe('#961 closing new-method orders that can no longer be paid', () => {
  beforeEach(() => { mocks.recover.mockReset(); });

  it('closes an order whose session expired without its webhook, after Stripe confirms it expired unpaid', async () => {
    const f = fixture({ bound: 'cs_lost' });
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'expired', paymentStatus: 'unpaid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('closed');
    // The webhook's own recovery reads the session at Stripe and closes through pay_waffo_observe_qualification.
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_lost');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('never closes a paid order: a paid session is delivered instead, an open one is left alone', async () => {
    const f = fixture({ bound: 'cs_paid' });
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'paid' });
    // Long after the local expiry: local time never decides that a paid order is unpaid.
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW + 30 * 86400)).resolves.toBe('paid');
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'unpaid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('open');
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'open', paymentStatus: 'unpaid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('open');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('closes a completed session whose async payment failed and whose failure webhook was lost, from Stripe\'s event', async () => {
    const f = fixture({ bound: 'cs_async', failedEvents: ['cs_other', 'cs_async'] });
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'unpaid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('closed');
    expect(f.events).toHaveBeenCalledWith(expect.objectContaining({ types: ['checkout.session.async_payment_failed'],
      created: { gte: NOW - 7200 - 300 } }));
    // The same recovery the webhook runs: it re-reads the session and closes only a complete, unpaid one.
    expect(mocks.recover).toHaveBeenLastCalledWith(f.db, f.stripe, 'cs_async', 'checkout.session.async_payment_failed');
    // Paid in the meantime: delivered, never closed. No failure event at Stripe: still pending, left alone.
    mocks.recover.mockResolvedValueOnce({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'unpaid' })
      .mockResolvedValueOnce({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'paid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('paid');
    const pending = fixture({ bound: 'cs_async', failedEvents: ['cs_other'] });
    mocks.recover.mockReset().mockResolvedValue({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'unpaid' });
    await expect(settleMethodOrder(pending.db, pending.stripe, scope, order(), NOW)).resolves.toBe('open');
    expect(mocks.recover).toHaveBeenCalledTimes(1);
  });

  it('a session found at Stripe without its local mapping goes through the same recovery, never a blind close', async () => {
    const f = fixture({ sessions: [{ id: 'cs_other', metadata: { orderId: 'x' } }, { id: 'cs_found', metadata: { orderId: ORDER } }] });
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'complete', paymentStatus: 'paid' });
    await expect(settleMethodOrder(f.db, f.stripe, scope, order(), NOW)).resolves.toBe('paid');
    expect(mocks.recover).toHaveBeenCalledWith(f.db, f.stripe, 'cs_found');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('closes a claimed order whose session was never created, only after Stripe shows none and the grace hour passed', async () => {
    const expires = NOW - 1800;
    const f = fixture();
    const claimed = order({ method_checkout_expires_at: iso(expires) });
    await expect(settleMethodOrder(f.db, f.stripe, scope, claimed, NOW)).resolves.toBe('waiting');
    expect(f.rpc).not.toHaveBeenCalled();
    await expect(settleMethodOrder(f.db, f.stripe, scope, claimed, expires + 3600)).resolves.toBe('closed');
    expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ created: { gte: expires - 86400, lte: expires } }));
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_close_uncreated', { p_user: USER, p_order: ORDER, p_merchant: 'fixture' });
  });

  it('releases an order that failed after admission and before its claim, after reading Stripe once', async () => {
    const created = NOW - 900;
    const stranded = order({ created_at: iso(created), method_dispatched_at: null, method_checkout_expires_at: null });
    const fresh = fixture();
    // A just-admitted order may be claimed any moment by its own request: left alone, Stripe not even asked.
    await expect(settleMethodOrder(fresh.db, fresh.stripe, scope, stranded, created + 60)).resolves.toBe('waiting');
    expect(fresh.list).not.toHaveBeenCalled();
    await expect(settleMethodOrder(fresh.db, fresh.stripe, scope, stranded, NOW)).resolves.toBe('closed');
    expect(fresh.list).toHaveBeenCalledTimes(1);
    expect(fresh.rpc).toHaveBeenCalledWith('pay_waffo_abort_before_dispatch', { p_user: USER, p_order: ORDER,
      p_merchant: 'fixture', p_expected: null });
    // Nothing is sent to Stripe before the claim; a session for it anyway is left for manual review.
    const odd = fixture({ sessions: [{ id: 'cs_odd', metadata: { orderId: ORDER } }] });
    await expect(settleMethodOrder(odd.db, odd.stripe, scope, stranded, NOW)).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(odd.rpc).not.toHaveBeenCalled();
  });

  it('an incomplete Stripe scan or a refused close never counts as closed', async () => {
    const partial = fixture({ listHasMore: true, sessions: [{ id: 'cs_a', metadata: {} }] });
    await expect(settleMethodOrder(partial.db, partial.stripe, scope, order(), NOW)).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(partial.rpc).not.toHaveBeenCalled();
    const refused = fixture({ closeError: 'PAY_WAFFO_CLOSE_DENIED' });
    await expect(settleMethodOrder(refused.db, refused.stripe, scope, order(), NOW)).rejects.toThrow('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  });

  it('a concurrent retry that claims first wins: the buyer is told the payment is still pending', async () => {
    // The order was claimed by its own request between the read and the close; the database refuses the release.
    const raced = fixture({ closeError: 'PAY_WAFFO_CLOSE_DENIED',
      rows: [order({ created_at: iso(NOW - 900), method_dispatched_at: null, method_checkout_expires_at: null })] });
    await expect(settleBuyerOrders(raced.db, raced.stripe, scope, USER, NOW)).resolves.toBe(false);
    expect(raced.filters).toEqual(expect.arrayContaining([['eq', 'user_id', USER], ['eq', 'payment_status', 'unpaid'],
      ['is', 'purchase_closed_at', null], ['is', 'fulfilled_at', null], ['eq', 'payment_channel', 'stripe']]));
    // Two settles of one order at once both reach the idempotent close; each reports it closed.
    const both = fixture({ bound: 'cs_lost', rows: [order()] });
    mocks.recover.mockResolvedValue({ orderId: ORDER, checkoutStatus: 'expired', paymentStatus: 'unpaid' });
    await expect(Promise.all([settleBuyerOrders(both.db, both.stripe, scope, USER, NOW),
      settleBuyerOrders(both.db, both.stripe, scope, USER, NOW)])).resolves.toEqual([true, true]);
  });

  it('the daily sweep pages through open orders, counts closed and delivered ones, and reports failures', async () => {
    const rows = ['a', 'b', 'c'].map(suffix => order({ id: `${ORDER.slice(0, -1)}${suffix}` }));
    const f = fixture({ bound: 'cs_x', rows });
    mocks.recover.mockResolvedValueOnce({ orderId: rows[0]!.id, checkoutStatus: 'expired', paymentStatus: 'unpaid' })
      .mockRejectedValueOnce(new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE'))
      .mockResolvedValueOnce({ orderId: rows[2]!.id, checkoutStatus: 'open', paymentStatus: 'unpaid' });
    const result = await settleOpenMethodOrders(f.db, f.stripe, scope, { now: NOW, deadline: Date.now() + 60_000, maxPages: 10,
      pageSize: 2 });
    expect(result).toMatchObject({ checked: 3, repaired: 1, complete: true,
      findings: [{ kind: 'open_order_unresolved', object: 'order', orderId: rows[1]!.id, code: 'PAY_WAFFO_CHECKOUT_UNAVAILABLE' }] });
    expect(f.filters).toEqual(expect.arrayContaining([['lt', 'created_at', iso(NOW - 600)], ['eq', 'payment_status', 'unpaid']]));
    const late = await settleOpenMethodOrders(f.db, f.stripe, scope, { now: NOW, deadline: Date.now() - 1, maxPages: 10 });
    expect(late).toMatchObject({ complete: false, checked: 0, findings: [{ kind: 'scan_incomplete', object: 'order' }] });
  });
});
