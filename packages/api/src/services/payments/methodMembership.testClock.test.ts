/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./stripeTestClock', () => ({ refreshStripeTestClockUser: refresh }));
import { readMethodMembership } from './methodMembership';

const WALL = Date.parse('2026-10-21T12:00:00Z');
const TERM_START = '2026-11-21T12:00:00Z', TERM_END = '2026-12-21T12:00:00Z';
const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
  NEXT_PUBLIC_SUPABASE_URL: 'https://gvcpmcunmfrbxuwimxfa.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'gvcpmcunmfrbxuwimxfa.supabase.co',
  V3_RUNTIME_STAGING_ENABLED: 'true', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001',
  STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true' };
const paid = (id: string, end = TERM_END, patch: Record<string, unknown> = {}) => ({ id, subscription_id: `s-${id}`,
  auto_renew: true, purchase_membership_level: 'pro', payment_channel: 'stripe', payment_method: 'card', offer_kind: 'standard',
  entitlement_start: TERM_START, entitlement_end: end, billing_cycle: 'monthly', ...patch });
const sub = (id: string, patch: Record<string, unknown> = {}) => ({ id: `s-${id}`, status: 'active', cancel_at_period_end: false,
  method_cancel_requested_at: null, method_cancel_confirmed_at: null, ...patch });
function fixture(orders: unknown[], subscriptions: unknown[], holds: unknown[] = []) {
  const frozen = new Set((holds as Array<{ order_id: string }>).map(row => row.order_id));
  const visible = (orders as ReturnType<typeof paid>[]).filter(row => !frozen.has(row.id));
  const latestTerms = [...new Set(visible.map(row => row.subscription_id))].map(id => ({ entitlement_end:
    visible.filter(row => row.subscription_id === id).map(row => row.entitlement_end).sort().at(-1) }));
  const responses: unknown[] = [null, orders, [], ...(orders.length ? [holds,
    ...(visible.length ? [subscriptions, ...latestTerms] : [])] : []),
    { value: { version: 'terms' } }, [{ id: 'gold-plan' }], []];
  const from = vi.fn(() => {
    const result = { data: responses.shift(), error: null };
    const q = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), gt: vi.fn(), or: vi.fn(), is: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue(result), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    for (const k of ['select', 'eq', 'not', 'gt', 'or', 'is', 'in', 'order', 'limit'] as const) q[k].mockReturnValue(q);
    return q;
  });
  return { db: { from, rpc: vi.fn() } as unknown as SupabaseClient, from };
}
describe('test-clock membership projection uses each paid source time', () => {
  beforeEach(() => refresh.mockReset().mockResolvedValue(new Map()));
  it('expires only the clock source after its own grace, keeping the ordinary source on wall time', async () => {
    refresh.mockResolvedValue(new Map([['clock', Date.parse(TERM_END) + 86400_001]]));
    const f = fixture([paid('clock'), paid('ordinary', '2026-11-21T12:00:00Z', { entitlement_start: '2026-10-21T12:00:00Z' })],
      [sub('clock'), sub('ordinary')]);
    const result = await readMethodMembership(f.db, 'user', WALL, env);
    expect(result.memberships.map(row => row.id)).toEqual(['ordinary']);
  });
  it.each([0, 23 * 3600_000 + 59 * 60_000])('keeps an unpaid-renewal grace at %s ms without inventing an order', async offset => {
    refresh.mockResolvedValue(new Map([['clock', Date.parse(TERM_END) + offset]]));
    const f = fixture([paid('clock')], [sub('clock')]);
    const result = await readMethodMembership(f.db, 'user', WALL, env);
    expect(result.memberships.map(row => [row.id, row.inGrace])).toEqual([['clock', true]]);
  });
  it('does not expose a future paid period before that source reaches its start', async () => {
    refresh.mockResolvedValue(new Map([['clock', Date.parse(TERM_START) - 1]]));
    const f = fixture([paid('clock')], [sub('clock')]);
    expect((await readMethodMembership(f.db, 'user', WALL, env)).memberships).toEqual([]);
  });
  it.each([
    { status: 'canceled', cancel_at_period_end: true },
    { method_cancel_requested_at: '2026-12-20T00:00:00Z' },
    { method_cancel_confirmed_at: '2026-12-20T00:00:00Z' },
  ])('does not retain grace after a stop: %j', async patch => {
    refresh.mockResolvedValue(new Map([['clock', Date.parse(TERM_END) + 1]]));
    const f = fixture([paid('clock')], [sub('clock', patch)]);
    expect((await readMethodMembership(f.db, 'user', WALL, env)).memberships).toEqual([]);
  });
  it('retains dispute holds before applying any simulated time', async () => {
    refresh.mockResolvedValue(new Map([['clock', Date.parse(TERM_START) + 1]]));
    const f = fixture([paid('clock')], [], [{ order_id: 'clock' }]);
    expect((await readMethodMembership(f.db, 'user', WALL, env)).memberships).toEqual([]);
  });
  it('does not request clock observations in live mode', async () => {
    const f = fixture([], []);
    const result = await readMethodMembership(f.db, 'user', WALL, env, 'live');
    expect(result.mode).toBe('live');
    expect(refresh).not.toHaveBeenCalled();
  });
});
