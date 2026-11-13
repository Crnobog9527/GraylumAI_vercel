/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { assertNoDisputePurchaseBlock, disputeBlock, DISPUTE_LOST_PURCHASE_MESSAGE, DISPUTE_OPEN_PURCHASE_MESSAGE } from './disputePurchaseBlock';

const row = (over: Record<string, unknown>) =>
  ({ provider: 'stripe', status: 'needs_response', closed_at: null, freeze_state: 'frozen', ...over }) as never;
it('blocks an open or lost dispute and lets a won one through', () => {
  expect(disputeBlock([])).toBe(null);
  expect(disputeBlock([row({})])).toBe('open');
  expect(disputeBlock([row({ status: 'warning_needs_response' })])).toBe('open');
  expect(disputeBlock([row({ status: 'won', closed_at: '2026-11-01T00:00:00Z', freeze_state: 'withdrawn' })])).toBe(null);
  expect(disputeBlock([row({ status: 'warning_closed', closed_at: '2026-11-01T00:00:00Z' })])).toBe(null);
  expect(disputeBlock([row({ status: 'lost', closed_at: '2026-11-01T00:00:00Z' })])).toBe('lost');
  // A lost dispute stays blocking even after an admin withdrew its hold; lost wins over open.
  expect(disputeBlock([row({}), row({ status: 'lost', closed_at: '2026-11-01T00:00:00Z', freeze_state: 'withdrawn' })])).toBe('lost');
  // Still open at the bank after our refund superseded the hold.
  expect(disputeBlock([row({ freeze_state: 'superseded' })])).toBe('open');
});
it('treats an admin-withdrawn Waffo hold as resolved, since Waffo sends no outcome', () => {
  expect(disputeBlock([row({ provider: 'waffo', status: 'under_review' })])).toBe('open');
  expect(disputeBlock([row({ provider: 'waffo', status: 'under_review', freeze_state: 'withdrawn' })])).toBe(null);
  expect(disputeBlock([row({ provider: 'stripe', freeze_state: 'withdrawn' })])).toBe('open');
});
function db(data: unknown, error: unknown = null) {
  const filters: unknown[] = [];
  const query: Record<string, unknown> = {};
  query.select = (f: string) => { filters.push(['select', f]); return query; };
  query.eq = (f: string, v: unknown) => { filters.push([f, v]); return query; };
  query.limit = async () => ({ data, error });
  return { client: { from: (t: string) => { filters.push(['from', t]); return query; } } as never, filters };
}
it('refuses with the user-facing wording, scoped to the buyer, and fails closed when unreadable', async () => {
  const open = db([row({})]);
  await expect(assertNoDisputePurchaseBlock(open.client, 'user-1')).rejects.toMatchObject({ code: 'FORBIDDEN', message: DISPUTE_OPEN_PURCHASE_MESSAGE });
  expect(open.filters).toContainEqual(['payment_orders.user_id', 'user-1']);
  await expect(assertNoDisputePurchaseBlock(db([row({ status: 'lost' })]).client, 'u'))
    .rejects.toMatchObject({ message: DISPUTE_LOST_PURCHASE_MESSAGE });
  await expect(assertNoDisputePurchaseBlock(db([]).client, 'u')).resolves.toBeUndefined();
  await expect(assertNoDisputePurchaseBlock(db(null, { message: 'x' }).client, 'u')).rejects.toThrow('PAY_DISPUTE_PURCHASE_CHECK_UNAVAILABLE');
});
