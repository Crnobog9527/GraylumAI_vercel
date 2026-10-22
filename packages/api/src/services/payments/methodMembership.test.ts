/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readMethodMembership } from './methodMembership';
const clock = vi.hoisted(() => ({ times: new Map<string, number>() }));
vi.mock('./stripeTestClock', () => ({ refreshStripeTestClockUser: vi.fn(async () => clock.times) }));
beforeEach(() => clock.times.clear());
const staging = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic-staging-project',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic-staging-project', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001', WAFFO_TEST_OPERATIONS_ENABLED: 'true' };
const routes = (card: boolean) => ({ version: 2, card: { enabled: card },
  wechat_pay: { enabled: card, annualVerified: true }, alipay: { enabled: card, annualVerified: true } });
function fixture(counts: Array<number | null> = [40, 3, 2], route: unknown = null,
  memberships: unknown[] = [], subscriptions: unknown[] | null = [], goldOrders: unknown[] = [], options: {
    founderStatus?: unknown; renewalOrder?: unknown; deadline?: string | null; laterTerms?: unknown[]; termsError?: boolean;
    refundedOrders?: unknown[];
  } = {}) {
  const results: Array<{ data: unknown; error: unknown }> = [{ data: route === null ? null : { value: route }, error: null },
    { data: memberships, error: null },
    { data: counts.some(n => n === null) ? null : counts.flatMap((n, i) =>
      Array.from({ length: n! }, () => ({ qualification_state: ['sold', 'reserved', 'review'][i] }))), error: null },
    { data: options.refundedOrders ?? [], error: null }];
  if (memberships.length) results.push({ data: [], error: null });
  const rows = memberships as Array<{ subscription_id: string; entitlement_end: string }>;
  const references = [...rows, ...(options.refundedOrders ?? [])] as typeof rows;
  const allTerms = [...references, ...(options.laterTerms ?? [])] as typeof rows;
  const subscriptionIds = new Set(references.map(row => row.subscription_id).filter(Boolean));
  if (subscriptionIds.size) results.push({ data: subscriptions, error: null });
  for (const sub of subscriptionIds) {
    const term = allTerms.filter(row => row.subscription_id === sub)
      .sort((a, b) => Date.parse(b.entitlement_end) - Date.parse(a.entitlement_end))[0];
    results.push({ data: term, error: options.termsError ? { message: 'unavailable' } : null });
  }
  results.push({ data: { value: { version: 'terms-2026-10' } }, error: null }, { data: [{ id: 'plan-gold' }], error: null },
    { data: goldOrders, error: null });
  if (options.renewalOrder !== undefined) results.push({ data: options.renewalOrder, error: null });
  const queries: Array<{ eq: ReturnType<typeof vi.fn>; not: ReturnType<typeof vi.fn>; or: ReturnType<typeof vi.fn>; gt: ReturnType<typeof vi.fn> }> = [];
  const from = vi.fn(() => {
    const result = results.shift();
    const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), gt: vi.fn(), or: vi.fn(), is: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    for (const method of ['select', 'eq', 'not', 'gt', 'or', 'is', 'in', 'order', 'limit'] as const) query[method].mockReturnValue(query);
    queries.push(query); return query;
  });
  const rpc = vi.fn((name: string) => Promise.resolve({ data: name === 'pay_founder_status' ? options.founderStatus ?? {
    state: 'none', orderId: null, foundedAt: null, periodEnd: null, deadline: null, endedAt: null, endedReason: null,
  } : options.deadline ?? null, error: null }));
  return { db: { from, rpc } as unknown as SupabaseClient, queries, rpc };
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
  it('projects enabled staging wallet routes as ready while leaving production unchanged', async () => {
    const projection = async (env: Record<string, string | undefined>, route: ReturnType<typeof routes>) =>
      readMethodMembership(fixture(undefined, route).db, '00000000-0000-4000-8000-000000000099', 0, env);
    const ready = async (env: Record<string, string | undefined>, route: ReturnType<typeof routes>) =>
      (await projection(env, route)).checkoutReady;
    const walletsOff = { ...routes(false), wechat_pay: { enabled: false, annualVerified: false },
      alipay: { enabled: false, annualVerified: false } };
    const wechatOn = { ...walletsOff, wechat_pay: { enabled: true, annualVerified: false } };
    const alipayOn = { ...walletsOff, alipay: { enabled: true, annualVerified: false } };
    expect(await ready(staging, wechatOn)).toBe(true);
    expect(await ready(staging, alipayOn)).toBe(true);
    expect(await ready(staging, walletsOff)).toBe(false);
    expect((await projection(staging, wechatOn)).checkoutMethods).toEqual(['wechat_pay']);
    expect((await projection(staging, alipayOn)).checkoutMethods).toEqual(['alipay']);
    expect((await projection(staging, walletsOff)).checkoutMethods).toEqual([]);
    for (const enabled of [true, false]) {
      const productionLike = { ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' };
      const productionProjection = await projection(productionLike, enabled ? routes(true) : walletsOff);
      expect(productionProjection.checkoutReady).toBe(false);
      expect(productionProjection.checkoutMethods).toEqual([]);
    }
  });
  it.each([
    ['wechat_pay', 'stripe', true], ['alipay', 'stripe', true], ['wechat_pay', 'waffo', false],
  ])('projects eligible staging founder renewal for %s / %s: %s', async (method, channel, eligible) => {
    const orderId = '00000000-0000-4000-8000-000000000031';
    const f = fixture(undefined, routes(true), [], [], [], {
      founderStatus: { state: 'active', orderId, foundedAt: '2026-01-01T00:00:00Z', periodEnd: '2027-01-01T00:00:00Z',
        deadline: null, endedAt: null, endedReason: null },
      renewalOrder: { item_id: 'plan-gold', subscription_id: '00000000-0000-4000-8000-000000000032',
        payment_method: method, payment_channel: channel, offer_kind: 'founder' },
      deadline: '2027-01-08T00:00:00Z',
    });
    const userId = '00000000-0000-4000-8000-000000000099';
    const result = await readMethodMembership(f.db, userId, Date.parse('2026-12-25T00:00:00Z'), staging);
    expect(result.founderRenewal).toEqual(eligible ? { itemId: 'plan-gold', subscriptionId: '00000000-0000-4000-8000-000000000032',
      eligibleUntil: '2027-01-08T00:00:00.000Z' } : null);
    expect(f.rpc).toHaveBeenCalledWith('pay_founder_status', { p_user: userId });
    if (eligible) expect(f.rpc).toHaveBeenCalledWith('pay_waffo_founder_deadline', { p_order: orderId });
    else expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_founder_deadline', { p_order: orderId });
    expect(f.queries.at(-1)?.eq).toHaveBeenCalledWith('payment_mode', 'test');
  });
  it('does not project the founder wallet renewal on a production deployment', async () => {
    const env = { ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' };
    const result = await readMethodMembership(fixture(undefined, routes(true)).db, 'actor', 0, env);
    expect(result.founderRenewal).toBeNull();
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
    expect(f.queries[5]?.eq).toHaveBeenCalledWith('user_id', 'actor');
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
  it.each(['card', 'card_cn'])('does not resurrect an older %s term after the later renewal is refunded', async method => {
    const now = Date.parse('2026-11-21T15:10:48Z');
    const first = { id: 'first', subscription_id: 'sub', auto_renew: true, purchase_membership_level: 'pro',
      payment_method: method, payment_channel: 'stripe', entitlement_start: '2026-10-21T14:09:48Z',
      entitlement_end: '2026-11-21T14:09:48Z' };
    const subscription = { id: 'sub', status: 'active', cancel_at_period_end: 'false' };
    // The completed/paid query excludes this refund, but the latest-term query must still see it.
    const f = fixture(undefined, null, [first], [subscription], [], { laterTerms: [{ id: 'renewal',
      subscription_id: 'sub', status: 'refunded', payment_status: 'refunded', entitlement_end: '2026-12-21T14:09:48Z' }] });
    clock.times.set(first.id, now);
    const result = await readMethodMembership(f.db, 'actor', Date.parse('2026-10-21T14:25:00Z'), staging);
    expect(result.memberships).toEqual([]);
    const latest = f.queries[6];
    expect(latest.eq).toHaveBeenCalledWith('user_id', 'actor');
    expect(latest.eq).toHaveBeenCalledWith('payment_mode', 'test');
    expect(latest.eq).toHaveBeenCalledWith('subscription_id', 'sub');
    expect(latest.eq).not.toHaveBeenCalledWith('status', expect.anything());
    expect(latest.eq).not.toHaveBeenCalledWith('payment_status', expect.anything());
  });
  it('keeps the actual latest term in grace and drops it after 24 hours; refund of another subscription does not hide it', async () => {
    const first = { id: 'first', subscription_id: 'sub', auto_renew: true, purchase_membership_level: 'pro',
      payment_method: 'card_cn', payment_channel: 'stripe', entitlement_end: '2026-11-21T14:09:48Z' };
    const sub = { id: 'sub', status: 'active', cancel_at_period_end: 'false' };
    const fresh = () => fixture(undefined, null, [first], [sub], [], { laterTerms: [
      { subscription_id: 'other', entitlement_end: '2026-12-21T14:09:48Z' }] });
    const during = await readMethodMembership(fresh().db, 'actor', Date.parse('2026-11-22T14:09:47Z'), staging);
    expect(during.memberships.map(row => [row.id, row.inGrace])).toEqual([['first', true]]);
    const expired = await readMethodMembership(fresh().db, 'actor', Date.parse('2026-11-22T14:09:48Z'), staging);
    expect(expired.memberships).toEqual([]);
  });
  it('fails closed if later-term evidence cannot be read', async () => {
    const f = fixture(undefined, null, [{ id: 'first', subscription_id: 'sub',
      entitlement_end: '2026-11-21T14:09:48Z' }], [{ id: 'sub' }], [], { termsError: true });
    await expect(readMethodMembership(f.db, 'actor', 0, staging)).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
  });
  it.each([
    ['active', false, null, true], ['past_due', false, null, true],
    ['active', true, null, false], ['canceled', true, null, false],
  ])('explains an externally refunded %s subscription without admitting another purchase', async (status, stopped, terminated, renewing) => {
    const refund = { id: 'refund', subscription_id: 'sub', status: 'refunded', payment_status: 'refunded',
      entitlement_end: '2026-12-21T14:09:48Z' };
    const f = fixture(undefined, null, [], [{ id: 'sub', status, cancel_at_period_end: String(stopped),
      current_period_end: refund.entitlement_end, credit_release_terminated_at: terminated }], [], { refundedOrders: [refund] });
    const result = await readMethodMembership(f.db, 'actor', Date.parse('2026-11-21T15:10:48Z'), staging);
    expect(result.memberships).toEqual([]);
    expect(result.refundedRenewalNotice?.message).toContain('这一期已退款');
    expect(result.refundedRenewalNotice?.message).toContain('管理订阅 / 取消续费');
    expect(result.refundedRenewalNotice?.message).toContain('联系客服');
    expect(result.refundedRenewalNotice?.buttonLabel).toBe(renewing ? '已退款，请先停止旧订阅续费' : '已退款，请先确认旧订阅或联系客服');
    expect(f.queries[3]?.eq).toHaveBeenCalledWith('payment_status', 'refunded');
    expect(f.queries[3]?.not).toHaveBeenCalledWith('fulfilled_at', 'is', null);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('does not block an approved refund termination or revive an older refund after a newer paid term', async () => {
    const refund = { id: 'refund', subscription_id: 'sub', status: 'refunded', payment_status: 'refunded',
      entitlement_end: '2026-12-21T14:09:48Z' };
    const terminated = fixture(undefined, null, [], [{ id: 'sub', status: 'canceled', cancel_at_period_end: 'true',
      current_period_end: refund.entitlement_end, credit_release_terminated_at: '2026-11-21T15:00:00Z' }], [], { refundedOrders: [refund] });
    expect((await readMethodMembership(terminated.db, 'actor', 0, staging)).refundedRenewalNotice).toBeNull();
    const renewed = fixture(undefined, null, [], [{ id: 'sub', status: 'active' }], [], { refundedOrders: [refund],
      laterTerms: [{ id: 'new-paid', subscription_id: 'sub', status: 'completed', payment_status: 'paid',
        entitlement_end: '2027-01-21T14:09:48Z' }] });
    expect((await readMethodMembership(renewed.db, 'actor', 0, staging)).refundedRenewalNotice).toBeNull();
  });
});
