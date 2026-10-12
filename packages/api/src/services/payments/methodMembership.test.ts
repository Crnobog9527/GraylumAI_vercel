/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi } from 'vitest';
import { readMethodMembership } from './methodMembership';
const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', WAFFO_TEST_OPERATIONS_ENABLED: 'true' };
const routes = (card: boolean) => ({ version: 2, card: { enabled: card },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });
function fixture(counts: Array<number | null> = [40, 3, 2], route: unknown = null,
  memberships: unknown[] = [], subscriptions: unknown[] | null = []) {
  const results = [{ data: route === null ? null : { value: route }, error: null }, { data: memberships, error: null },
    { data: counts.some(n => n === null) ? null : counts.flatMap((n, i) =>
      Array.from({ length: n! }, () => ({ qualification_state: ['sold', 'reserved', 'review'][i] }))), error: null },
    { data: subscriptions, error: null }];
  const queries: Array<{ eq: ReturnType<typeof vi.fn>; not: ReturnType<typeof vi.fn> }> = [];
  const from = vi.fn(() => {
    const result = results.shift();
    const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), gt: vi.fn(), or: vi.fn(), is: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    for (const method of ['select', 'eq', 'not', 'gt', 'or', 'is', 'in', 'order', 'limit'] as const) query[method].mockReturnValue(query);
    queries.push(query); return query;
  });
  return { db: { from } as unknown as SupabaseClient, queries };
}
describe('method membership read projection', () => {
  it('uses real sold/reserved/review counts across channels; remains closed', async () => {
    const f = fixture(); const result = await readMethodMembership(f.db, 'actor', 1791676800000, staging);
    expect(result.founder).toEqual({ total: 50, sold: 40, reserved: 5, available: 5 });
    expect(result.checkoutReady).toBe(false);
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('user_id', 'actor');
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('payment_status', 'paid');
    expect(f.queries[1]?.not).toHaveBeenCalledWith('fulfilled_at', 'is', null);
    for (const q of f.queries.slice(2)) {
      expect(q.eq).toHaveBeenCalledWith('payment_mode', 'test');
      expect(q.eq).not.toHaveBeenCalledWith('merchant_namespace', expect.anything());
      expect(q.eq).not.toHaveBeenCalledWith('payment_status', expect.anything());
    }
  });
  it('keeps card checkout not ready everywhere until the Stripe card checkout lands (PAY-STRIPE-MP PR-1)', async () => {
    for (const env of [staging, { ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' }]) {
      for (const enabled of [true, false]) {
        expect((await readMethodMembership(fixture(undefined, routes(enabled)).db, 'actor', 0, env)).checkoutReady).toBe(false);
      }
    }
  });
  it('does not present missing count as zero or hide oversold state', async () => {
    await expect(readMethodMembership(fixture([null, 0, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
    await expect(readMethodMembership(fixture([50, 1, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  });
  it('reports auto_renew off once the stop is confirmed, matching getEntitlements cancel_at_period_end', async () => {
    const paid = (id: string, sub: string) => ({ id, subscription_id: sub, auto_renew: true, purchase_membership_level: 'gold' });
    const f = fixture(undefined, null, [paid('o1', 's1'), paid('o2', 's2')],
      [{ id: 's1', cancel_at_period_end: 'true' }, { id: 's2', cancel_at_period_end: 'false' }]);
    const result = await readMethodMembership(f.db, 'actor', 0, staging);
    expect(result.memberships.map(m => [m.id, m.auto_renew, m.cancel_at_period_end]))
      .toEqual([['o1', false, true], ['o2', true, false]]);
    expect(f.queries[3]?.eq).toHaveBeenCalledWith('user_id', 'actor');
  });
  it('never shows a one-time purchase as renewing and fails closed on a missing subscription row', async () => {
    const once = { id: 'o1', subscription_id: 's1', auto_renew: false };
    const ok = await readMethodMembership(fixture(undefined, null, [once], [{ id: 's1', cancel_at_period_end: 'false' }]).db, 'actor');
    expect(ok.memberships[0]?.auto_renew).toBe(false);
    await expect(readMethodMembership(fixture(undefined, null, [once], []).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
    await expect(readMethodMembership(fixture(undefined, null, [once], null).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  });
});
