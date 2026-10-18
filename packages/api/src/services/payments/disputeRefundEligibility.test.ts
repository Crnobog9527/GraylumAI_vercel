/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { disputeAllowsRefund } from './disputeRefundEligibility';
const scope = { merchant: 'fixture', mode: 'test' as const };
function fixture() {
  const row = { provider_dispute_id: 'du_test', provider_charge_id: 'ch_test',
    provider_payment_intent_id: 'pi_test', freeze_state: 'withdrawn' };
  const local = { data: [row], error: null as unknown };
  const filters: unknown[] = [];
  const query = { select: () => query, eq: (field: string, value: string) => { filters.push([field, value]); return query; },
    limit: async () => local };
  const db = { from: vi.fn(() => query) } as unknown as Pick<SupabaseClient, 'from'>;
  const dispute = { id: 'du_test', object: 'dispute', charge: 'ch_test', payment_intent: 'pi_test',
    livemode: false, status: 'won', is_charge_refundable: true };
  const actual = { data: [dispute], has_more: false };
  const list = vi.fn(async () => actual);
  const stripe = { disputes: { list } } as unknown as Pick<Stripe, 'disputes'>;
  const charge = { id: 'ch_test', disputed: true, payment_intent: 'pi_test', livemode: false } as Stripe.Charge;
  return { row, local, actual, dispute, filters, db, stripe, charge, list,
    run: () => disputeAllowsRefund(db, stripe, scope, 'order', charge) };
}
it('permits a withdrawn, won and provider-refundable dispute even though charge.disputed stays true', async () => {
  const f = fixture(); expect(await f.run()).toBe(true);
  expect(f.filters).toContainEqual(['order_id', 'order']);
  expect(f.filters).toContainEqual(['merchant_namespace', 'fixture']);
  expect(f.filters).toContainEqual(['mode', 'test']);
  expect(f.list).toHaveBeenCalledWith({ charge: 'ch_test', limit: 100 });
});
it('keeps undisputed payments on the existing path without new reads', async () => {
  const f = fixture(); f.charge.disputed = false;
  expect(await f.run()).toBe(true); expect(f.db.from).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
});
it.each(['frozen', 'pending', 'review', 'superseded', 'external'])('refuses a local %s dispute', async state => {
  const f = fixture(); f.row.freeze_state = state;
  expect(await f.run()).toBe(false); expect(f.list).not.toHaveBeenCalled();
});
it.each(['needs_response', 'under_review', 'lost', 'warning_closed'])('refuses provider status %s after a local withdrawal', async status => {
  const f = fixture(); f.dispute.status = status; expect(await f.run()).toBe(false);
});
it('fails closed on incomplete history, unknown disputes, identity/mode mismatch and read failures', async () => {
  for (const patch of ['page', 'extra', 'id', 'charge', 'payment', 'mode', 'refund', 'missing', 'database', 'provider']) {
    const f = fixture();
    if (patch === 'page') f.actual.has_more = true;
    if (patch === 'extra') f.actual.data.push({ ...f.dispute, id: 'du_other' });
    if (patch === 'id') f.dispute.id = 'du_other';
    if (patch === 'charge') f.dispute.charge = 'ch_other';
    if (patch === 'payment') f.dispute.payment_intent = 'pi_other';
    if (patch === 'mode') f.dispute.livemode = true;
    if (patch === 'refund') f.dispute.is_charge_refundable = false;
    if (patch === 'missing') f.local.data = [];
    if (patch === 'database') f.local.error = { code: 'XX000' };
    if (patch === 'provider') f.list.mockRejectedValue(new Error('provider unavailable'));
    expect(await f.run(), patch).toBe(false);
  }
});
