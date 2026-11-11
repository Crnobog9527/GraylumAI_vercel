/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ card: vi.fn(), legacy: vi.fn() }));
vi.mock('./cardSubscriptionWebhook', () => ({ handleCardSubscriptionState: mocks.card }));
vi.mock('../stripeFulfillment', () => ({ syncSubscriptionState: mocks.legacy }));
import { reconcileStaleSubscriptions, refreshBuyerStaleSubscriptions, STALE_AFTER_MS } from './staleSubscriptionRefresh';

const scope = { merchant: 'fixture', mode: 'test' } as const;
const now = Date.parse('2026-11-11T04:00:00.000Z');
type Row = { id: string; user_id: string; status: string; cancel_at_period_end: string; stripe_subscription_id: string | null;
  refs?: string[] };

/** user_subscriptions (stale scan and re-read) and payment_provider_refs; the sync mocks write `rows[id].status`. */
function fixture(rows: Row[]) {
  const byId = new Map(rows.map(row => [row.id, { ...row }]));
  const filters: Array<Record<string, unknown>> = [];
  const db = { from: vi.fn((table: string) => {
    const f: Record<string, unknown> = { table };
    filters.push(f);
    const chain = {
      select: vi.fn(() => chain), in: vi.fn((k: string, v: unknown) => { f[`in:${k}`] = v; return chain; }),
      eq: vi.fn((k: string, v: unknown) => { f[k] = v; return chain; }), lt: vi.fn((k: string, v: unknown) => { f[`lt:${k}`] = v; return chain; }),
      or: vi.fn((v: string) => { f.or = v; return chain; }), gt: vi.fn((k: string, v: unknown) => { f[`gt:${k}`] = v; return chain; }),
      order: vi.fn(() => chain),
      limit: vi.fn(async (n: number) => {
        if (table === 'payment_provider_refs') {
          const row = byId.get(f.subscription_id as string);
          return { error: null, data: (row?.refs ?? []).map(external_id => ({ external_id })) };
        }
        const after = (f['gt:id'] as string | undefined) ?? '';
        const data = [...byId.values()].filter(row => row.status === 'active' && row.id > after
          && (!f.user_id || row.user_id === f.user_id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, n).map(row => ({ ...row }));
        return { error: null, data };
      }),
      maybeSingle: vi.fn(async () => ({ error: null, data: byId.get(f.id as string) ?? null })),
    };
    return chain;
  }) };
  const cancel = (subscriptionId: string) => {
    for (const row of byId.values()) if (row.refs?.includes(subscriptionId)) row.status = 'canceled';
  };
  return { db: db as unknown as SupabaseClient, stripe: {} as Stripe, byId, filters, cancel };
}
const mp = (id: string, patch: Partial<Row> = {}): Row => ({ id, user_id: 'u1', status: 'active', cancel_at_period_end: 'false',
  stripe_subscription_id: null, refs: [`sub_${id}`], ...patch });

describe('PAY-STALE-SUB: subscriptions Stripe has ended but that still read as renewing', () => {
  beforeEach(() => { mocks.card.mockReset(); mocks.legacy.mockReset(); });

  it('selects only renewing Stripe rows of this account a day past their period, card rows not already stopped', async () => {
    const f = fixture([]);
    await refreshBuyerStaleSubscriptions(f.db, f.stripe, scope, 'u1', now);
    expect(f.filters[0]).toMatchObject({ table: 'user_subscriptions', payment_channel: 'stripe', merchant_namespace: 'fixture',
      payment_mode: 'test', user_id: 'u1', 'in:status': ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'],
      'lt:current_period_end': new Date(now - STALE_AFTER_MS).toISOString(),
      or: 'stripe_subscription_id.not.is.null,cancel_at_period_end.eq.false' });
  });

  it('applies an ended card subscription through the webhook handler and a legacy one through the legacy sync', async () => {
    const f = fixture([mp('a'), mp('b', { stripe_subscription_id: 'sub_b', cancel_at_period_end: 'true' })]);
    mocks.card.mockImplementation(async (_db: unknown, _stripe: unknown, id: string) => { f.cancel(id); return true; });
    mocks.legacy.mockImplementation(async (_db: unknown, sub: { id: string }) => { f.cancel(sub.id); });
    await expect(refreshBuyerStaleSubscriptions(f.db, f.stripe, scope, 'u1', now)).resolves.toBe(true);
    expect(mocks.card).toHaveBeenCalledWith(f.db, f.stripe, 'sub_a');
    expect(mocks.legacy).toHaveBeenCalledWith(f.db, { id: 'sub_b' });
    expect(f.byId.get('a')?.status).toBe('canceled');
    expect(f.byId.get('b')?.status).toBe('canceled');
    // Duplicate: both are canceled now, so a second pass finds nothing stale and changes nothing.
    mocks.card.mockClear(); mocks.legacy.mockClear();
    await expect(refreshBuyerStaleSubscriptions(f.db, f.stripe, scope, 'u1', now)).resolves.toBe(false);
    expect(mocks.card).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it('keeps a subscription Stripe still renews (retry days 1, 3, 5) as it is: the purchase stays refused', async () => {
    const f = fixture([mp('a')]);
    mocks.card.mockResolvedValue(true);
    await expect(refreshBuyerStaleSubscriptions(f.db, f.stripe, scope, 'u1', now)).resolves.toBe(false);
    expect(f.byId.get('a')?.status).toBe('active');
  });

  it('a Stripe or mapping failure keeps the refusal on the purchase path and is a finding in the daily scan', async () => {
    const f = fixture([mp('a'), mp('b', { refs: [] }), mp('c', { stripe_subscription_id: 'sub_other' })]);
    mocks.card.mockRejectedValue(new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE'));
    await expect(refreshBuyerStaleSubscriptions(f.db, f.stripe, scope, 'u1', now)).resolves.toBe(false);
    const result = await reconcileStaleSubscriptions(f.db, f.stripe, scope, { deadline: Date.now() + 60_000, maxPages: 5, now });
    expect(result).toMatchObject({ checked: 3, repaired: 0, complete: true });
    expect(result.findings).toEqual([
      { kind: 'repair_failed', object: 'subscription', externalId: 'a', code: 'PAY_WAFFO_PROVIDER_UNAVAILABLE' },
      { kind: 'repair_failed', object: 'subscription', externalId: 'b', code: 'PAY_COMMON_MAPPING_READ_FAILED' },
      // The legacy column and our mapping disagree: never sync a different Stripe subscription.
      { kind: 'repair_failed', object: 'subscription', externalId: 'c', code: 'PAY_COMMON_MAPPING_READ_FAILED' },
    ]);
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it('an unclaimed card subscription is a finding, never silently skipped', async () => {
    const f = fixture([mp('a')]);
    mocks.card.mockResolvedValue(false);
    const result = await reconcileStaleSubscriptions(f.db, f.stripe, scope, { deadline: Date.now() + 60_000, maxPages: 5, now });
    expect(result.findings).toEqual([{ kind: 'repair_failed', object: 'subscription', externalId: 'a', code: 'PAY_STALE_SUB_UNCLAIMED' }]);
  });

  it('pages past the last row seen, stops at the time budget and reports a scan over the page cap', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    const f = fixture(ids.map(id => mp(id, { user_id: id })));
    mocks.card.mockImplementation(async (_db: unknown, _stripe: unknown, id: string) => { f.cancel(id); return true; });
    expect(await reconcileStaleSubscriptions(f.db, f.stripe, scope, { deadline: Date.now() + 60_000, maxPages: 5, now }))
      .toMatchObject({ checked: 150, repaired: 150, complete: true, findings: [] });
    const capped = fixture(ids.map(id => mp(id, { user_id: id })));
    mocks.card.mockResolvedValue(true);
    expect(await reconcileStaleSubscriptions(capped.db, capped.stripe, scope, { deadline: Date.now() + 60_000, maxPages: 1, now }))
      .toMatchObject({ checked: 100, complete: false, findings: [{ kind: 'scan_incomplete', code: 'STALE_SUBSCRIPTIONS_OVER_LIMIT' }] });
    expect(await reconcileStaleSubscriptions(capped.db, capped.stripe, scope, { deadline: Date.now() - 1, maxPages: 5, now }))
      .toMatchObject({ checked: 0, complete: false, findings: [{ kind: 'scan_incomplete', code: 'TIME_BUDGET' }] });
  });
});
