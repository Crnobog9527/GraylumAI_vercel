/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi } from 'vitest';
import { readMethodMembership } from './methodMembership';
const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic-staging-project',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic-staging-project', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001', WAFFO_TEST_OPERATIONS_ENABLED: 'true' };
const routes = (card: boolean) => ({ version: 2, card: { enabled: card },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });
function fixture(counts: Array<number | null> = [40, 3, 2], route: unknown = null,
  memberships: unknown[] = [], subscriptions: unknown[] | null = [], goldOrders: unknown[] = []) {
  const results: Array<{ data: unknown; error: null }> = [{ data: route === null ? null : { value: route }, error: null },
    { data: memberships, error: null },
    { data: counts.some(n => n === null) ? null : counts.flatMap((n, i) =>
      Array.from({ length: n! }, () => ({ qualification_state: ['sold', 'reserved', 'review'][i] }))), error: null }];
  if (memberships.length) results.push({ data: subscriptions, error: null });
  results.push({ data: { value: { version: 'terms-2026-10' } }, error: null }, { data: [{ id: 'plan-gold' }], error: null },
    { data: goldOrders, error: null });
  const queries: Array<{ eq: ReturnType<typeof vi.fn>; not: ReturnType<typeof vi.fn>; or: ReturnType<typeof vi.fn>; gt: ReturnType<typeof vi.fn> }> = [];
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
  it('R7: reads paid memberships, founder seats and Gold history in the Stripe account mode it is given', async () => {
    const f = fixture(); const result = await readMethodMembership(f.db, 'actor', 1791676800000, staging, 'live');
    expect(result.mode).toBe('live');
    for (const q of [f.queries[1], f.queries[2], f.queries.at(-1)]) {
      expect(q?.eq).toHaveBeenCalledWith('payment_mode', 'live');
      expect(q?.eq).not.toHaveBeenCalledWith('payment_mode', 'test');
    }
  });
  it('uses real sold/reserved/review counts across channels; remains closed', async () => {
    const f = fixture(); const result = await readMethodMembership(f.db, 'actor', 1791676800000, staging);
    expect(result.founder).toEqual({ total: 50, sold: 40, reserved: 5, available: 5 });
    expect(result.checkoutReady).toBe(false);
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('user_id', 'actor');
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('payment_status', 'paid');
    expect(f.queries[1]?.not).toHaveBeenCalledWith('fulfilled_at', 'is', null);
    for (const q of f.queries.slice(2, 3)) {
      expect(q.eq).toHaveBeenCalledWith('payment_mode', 'test');
      expect(q.eq).not.toHaveBeenCalledWith('merchant_namespace', expect.anything());
      expect(q.eq).not.toHaveBeenCalledWith('payment_status', expect.anything());
    }
  });
  it('reports card checkout ready only on staging with the server switch on (PAY-STRIPE-MP 3c)', async () => {
    const ready = async (env: typeof staging, enabled: boolean) =>
      (await readMethodMembership(fixture(undefined, routes(enabled)).db, 'actor', 0, env)).checkoutReady;
    expect(await ready(staging, true)).toBe(true);
    expect(await ready(staging, false)).toBe(false);
    for (const enabled of [true, false]) {
      expect(await ready({ ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' }, enabled)).toBe(false);
    }
  });
  it('tells the purchase entry the terms version and whether the Gold first-month offer applies (display only)', async () => {
    const first = await readMethodMembership(fixture().db, 'actor', 0, staging);
    expect([first.termsVersion, first.goldFirstMonthEligible]).toEqual(['terms-2026-10', true]);
    const f = fixture(undefined, null, [], [], [{ id: 'gold-order' }]);
    expect((await readMethodMembership(f.db, 'actor', 0, staging)).goldFirstMonthEligible).toBe(false);
    const gold = f.queries.at(-1)!;
    expect(gold.eq).toHaveBeenCalledWith('user_id', 'actor');
    // Legacy Gold orders (before 0170) count too, by metadata or plan, as 0222 admission does.
    expect(gold.or).toHaveBeenCalledWith('and(or(purchase_membership_level.eq.gold,metadata->>membershipLevel.eq.gold,'
      + 'item_id.in.(plan-gold)),or(payment_status.in.(paid,refunded,partially_refunded),fulfilled_at.not.is.null))');
  });
  it('does not present missing count as zero or hide oversold state', async () => {
    await expect(readMethodMembership(fixture([null, 0, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
    await expect(readMethodMembership(fixture([50, 1, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  });
  it('reports auto_renew off once the stop is confirmed, matching getEntitlements cancel_at_period_end', async () => {
    const paid = (id: string, sub: string) => ({ id, subscription_id: sub, auto_renew: true, purchase_membership_level: 'gold',
      entitlement_end: '2026-11-01T00:00:00.000Z' });
    const f = fixture(undefined, null, [paid('o1', 's1'), paid('o2', 's2')],
      [{ id: 's1', cancel_at_period_end: 'true' }, { id: 's2', cancel_at_period_end: 'false' }]);
    const result = await readMethodMembership(f.db, 'actor', 0, staging);
    expect(result.memberships.map(m => [m.id, m.auto_renew, m.cancel_at_period_end]))
      .toEqual([['o1', false, true], ['o2', true, false]]);
    expect(f.queries[3]?.eq).toHaveBeenCalledWith('user_id', 'actor');
  });
  it('returns a still-renewing card subscription in its 24-hour renewal grace, marked inGrace (same rule as entitlements)', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z');
    const order = (id: string, sub: string, end: string, extra: Record<string, unknown> = {}) => ({ id, subscription_id: sub,
      auto_renew: true, purchase_membership_level: 'pro', payment_channel: 'stripe', payment_method: 'card', entitlement_end: end, ...extra });
    const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'active', cancel_at_period_end: 'false',
      method_cancel_requested_at: null, method_cancel_confirmed_at: null, ...extra });
    const ended = '2026-10-14T02:00:00.000Z';
    const f = fixture(undefined, null, [
      order('grace', 's1', ended), order('mainland', 's2', ended, { payment_method: 'card_cn' }),
      order('current', 's3', '2026-11-01T00:00:00.000Z'),
      order('stopped', 's4', ended), order('stop-asked', 's5', ended), order('wallet', 's6', ended, { payment_method: 'alipay' }),
      order('renewed-old', 's7', ended), order('renewed-new', 's7', '2026-11-14T02:00:00.000Z'),
    ], [sub('s1'), sub('s2'), sub('s3'), sub('s4', { cancel_at_period_end: 'true' }),
      sub('s5', { method_cancel_requested_at: '2026-10-13T00:00:00.000Z' }), sub('s6'), sub('s7')]);
    const result = await readMethodMembership(f.db, 'actor', now, staging);
    expect(result.memberships.map(m => [m.id, m.inGrace])).toEqual([['grace', true], ['mainland', true], ['current', false],
      ['renewed-new', false]]);
    // The query also reaches back 24 hours; anything older never shows.
    expect(f.queries[1]?.gt).toHaveBeenCalledWith('entitlement_end', '2026-10-13T12:00:00.000Z');
  });
  it('never shows a one-time purchase as renewing and fails closed on a missing subscription row', async () => {
    const once = { id: 'o1', subscription_id: 's1', auto_renew: false, entitlement_end: '2026-11-01T00:00:00.000Z' };
    const ok = await readMethodMembership(fixture(undefined, null, [once], [{ id: 's1', cancel_at_period_end: 'false' }]).db, 'actor');
    expect(ok.memberships[0]?.auto_renew).toBe(false);
    await expect(readMethodMembership(fixture(undefined, null, [once], []).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
    await expect(readMethodMembership(fixture(undefined, null, [once], null).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  });
});
