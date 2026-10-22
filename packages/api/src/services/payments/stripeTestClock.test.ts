/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const resolveScope = vi.hoisted(() => vi.fn());
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: resolveScope }));
import { observeStripeTestClock, refreshStripeTestClockOrder, refreshStripeTestClockUser, stripeTestClockRuntimeOpen, STRIPE_TEST_CLOCK_BINDING } from './stripeTestClock';
import { stripeWebhookErrorCode } from './stripeWebhookError';
const env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
  NEXT_PUBLIC_SUPABASE_URL: 'https://gvcpmcunmfrbxuwimxfa.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'gvcpmcunmfrbxuwimxfa.supabase.co',
  V3_RUNTIME_STAGING_ENABLED: 'true', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001',
  STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true' };
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const order = { id: 'order', user_id: 'owner', payment_channel: 'stripe', payment_mode: 'test', merchant_namespace: scope.merchant,
  payment_method: 'card', stripe_managed_payments: true, purchase_membership_level: 'pro', billing_cycle: 'monthly', item_type: 'membership_plan',
  checkout_request: { providerRequest: { customer: 'cus_clockfixture' } } };
const AS_OF = 1797854400;
function fixture() {
  const customer = { id: 'cus_clockfixture', object: 'customer', deleted: false, livemode: false,
    metadata: { graylum_user_id: 'owner' }, test_clock: 'clock_fixture' };
  const clock = { id: 'clock_fixture', object: 'test_helpers.test_clock', livemode: false, status: 'ready', frozen_time: AS_OF };
  const customers = { retrieve: vi.fn().mockImplementation(async () => customer) };
  const clocks = { retrieve: vi.fn().mockImplementation(async () => clock) };
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const sources: unknown[] = [order];
  const q = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), not: vi.fn(), limit: vi.fn().mockImplementation(async () => ({ data: sources, error: null })) };
  for (const key of ['select', 'eq', 'in', 'not'] as const) q[key].mockReturnValue(q);
  const from = vi.fn().mockReturnValue(q);
  return { customer, clock, customers, clocks, rpc, from, sources,
    db: { rpc, from } as unknown as SupabaseClient,
    stripe: { customers, testHelpers: { testClocks: clocks } } as unknown as Stripe };
}
describe('authoritative narrow Stripe test-clock context', () => {
  beforeEach(() => { resolveScope.mockReset().mockResolvedValue(scope); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('admits only the exact staging binding', () => { expect(stripeTestClockRuntimeOpen(env)).toBe(true); });
  it.each([
    { VERCEL: '0' }, { VERCEL_ENV: 'preview' }, { VERCEL_PROJECT_ID: 'other' }, { VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' },
    { VERCEL_GIT_COMMIT_REF: 'main' }, { VERCEL_GIT_REPO_OWNER: 'other' }, { VERCEL_GIT_REPO_SLUG: 'other' },
    { V3_RUNTIME_STAGING_ENABLED: 'false' }, { STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'false' },
    { V3_RUNTIME_STAGING_PROJECT_ID: 'other' }, { V3_RUNTIME_STAGING_WINDOW_ID: '' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co', V3_RUNTIME_STAGING_DATABASE_HOST: 'other.supabase.co' },
    { NEXT_PUBLIC_SUPABASE_URL: 'https://gvcpmcunmfrbxuwimxfa.supabase.co/wrong' },
  ])('preserves the ordinary path with no calls for a missing environment gate: %j', async patch => {
    const f = fixture();
    expect(stripeTestClockRuntimeOpen({ ...env, ...patch })).toBe(false);
    await expect(observeStripeTestClock(f.db, f.stripe, scope, order, { ...env, ...patch })).resolves.toBeNull();
    expect(resolveScope).not.toHaveBeenCalled(); expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { payment_mode: 'live' }, { payment_channel: 'waffo' }, { merchant_namespace: 'other' }, { payment_method: 'card_cn' },
    { stripe_managed_payments: false }, { purchase_membership_level: 'gold' }, { billing_cycle: 'yearly' },
    { item_type: 'credit_package' }, { checkout_request: null }, { checkout_request: { providerRequest: {} } },
  ])('does no additional provider or database work for ordinary orders: %j', async patch => {
    const f = fixture();
    await expect(observeStripeTestClock(f.db, f.stripe, scope, { ...order, ...patch }, env)).resolves.toBeNull();
    expect(resolveScope).not.toHaveBeenCalled(); expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('does not read or alter live-mode calls even on the exact staging binding', async () => {
    const f = fixture();
    await expect(observeStripeTestClock(f.db, f.stripe, { ...scope, mode: 'live' }, order, env)).resolves.toBeNull();
    expect(resolveScope).not.toHaveBeenCalled(); expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([{ mode: 'live', merchant: scope.merchant }, { mode: 'test', merchant: 'other' }])(
    'rejects a changed server-resolved merchant/mode: %j', async actual => {
      resolveScope.mockResolvedValue(actual); const f = fixture();
      await expect(observeStripeTestClock(f.db, f.stripe, scope, order, env)).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
      expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    });
  it.each([
    { deleted: true }, { id: 'cus_other' }, { livemode: true }, { metadata: { graylum_user_id: 'another-user' } },
    { metadata: {} }, { test_clock: null },
  ])('rejects a deleted, live, unowned or clockless customer: %j', async patch => {
    const f = fixture(); Object.assign(f.customer, patch);
    await expect(observeStripeTestClock(f.db, f.stripe, scope, order, env)).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.clocks.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'clock_other' }, { object: 'customer' }, { livemode: true }, { status: 'internal_failure' },
    { frozen_time: 0 }, { frozen_time: -1 }, { frozen_time: AS_OF + 0.5 }, { frozen_time: Number.MAX_SAFE_INTEGER },
  ])('never guesses a failed, wrong or unready clock time: %j', async patch => {
    const f = fixture(); Object.assign(f.clock, patch);
    await expect(observeStripeTestClock(f.db, f.stripe, scope, order, env)).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['card', 'card_cn'])('retries advancing %s observations without accepting stale time', async method => {
    const f = fixture();
    const source = { ...order, payment_method: method, stripe_managed_payments: method === 'card' };
    f.clock.status = 'advancing';
    const observe = () => observeStripeTestClock(f.db, f.stripe, scope, source, env);
    const attempts = await Promise.allSettled([observe(), observe()]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      if (attempt.status === 'rejected') {
        expect(attempt.reason.message).toBe('PAY_STRIPE_TEST_CLOCK_NOT_READY');
        expect(stripeWebhookErrorCode(attempt.reason)).toBe('PAY_STRIPE_TEST_CLOCK_NOT_READY');
      }
    }
    expect(f.rpc).not.toHaveBeenCalled();
    f.clock.status = 'ready';
    f.clock.frozen_time += 3600;
    const ready = await Promise.all([observe(), observe()]);
    expect(ready).toEqual([expect.objectContaining({ asOf: new Date(f.clock.frozen_time * 1000).toISOString() }),
      expect.objectContaining({ asOf: new Date(f.clock.frozen_time * 1000).toISOString() })]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.clocks.retrieve).toHaveBeenCalledTimes(4);
  });
  it.each([{ id: 'other' }, { object: 'customer' }, { livemode: true },
    { frozen_time: 0 }, { frozen_time: AS_OF + 0.5 }, { frozen_time: Number.MAX_SAFE_INTEGER }])(
    'keeps invalid advancing clock evidence a conflict: %j', async patch => {
      const f = fixture(); Object.assign(f.clock, { status: 'advancing' }, patch);
      await expect(observeStripeTestClock(f.db, f.stripe, scope, order, env))
        .rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
      expect(f.rpc).not.toHaveBeenCalled();
    });
  it('persists only the freshly read clock time and exact environment binding, re-reading every duplicate', async () => {
    const f = fixture();
    const observed = await observeStripeTestClock(f.db, f.stripe, scope, order, env);
    expect(observed).toEqual({ customerId: f.customer.id, clockId: f.clock.id, asOf: new Date(AS_OF * 1000).toISOString() });
    expect(f.rpc).toHaveBeenCalledWith('pay_stripe_test_clock_observe', { p_order: order.id, p_customer: f.customer.id,
      p_clock: f.clock.id, p_as_of: new Date(AS_OF * 1000).toISOString(), p_binding: STRIPE_TEST_CLOCK_BINDING });
    f.clock.frozen_time += 3600;
    await observeStripeTestClock(f.db, f.stripe, scope, order, env);
    expect(f.customers.retrieve).toHaveBeenCalledTimes(2); expect(f.clocks.retrieve).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenLastCalledWith('pay_stripe_test_clock_observe', expect.objectContaining({ p_as_of: new Date((AS_OF + 3600) * 1000).toISOString() }));
  });
  it('observes the same verified customer/clock for mainland non-MP sources', async () => {
    const f = fixture();
    const mainland = { ...order, payment_method: 'card_cn', stripe_managed_payments: false };
    await expect(observeStripeTestClock(f.db, f.stripe, scope, mainland, env)).resolves.toMatchObject({
      customerId: f.customer.id, clockId: f.clock.id });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('pay_stripe_test_clock_observe', expect.objectContaining({ p_order: order.id }));
  });
  it.each(['environment', 'scope-live', 'order-live', 'customer-live', 'owner', 'clockless', 'clock-live', 'unready'])(
    'keeps mainland observation closed when %s gate is missing', async missing => {
      const f = fixture();
      const mainland = { ...order, payment_method: 'card_cn', stripe_managed_payments: false };
      const actualEnv = missing === 'environment' ? { ...env, VERCEL_GIT_COMMIT_REF: 'main' } : env;
      const actualScope = missing === 'scope-live' ? { ...scope, mode: 'live' as const } : scope;
      if (missing === 'order-live') mainland.payment_mode = 'live';
      if (missing === 'customer-live') f.customer.livemode = true;
      if (missing === 'owner') f.customer.metadata.graylum_user_id = 'other';
      if (missing === 'clockless') Object.assign(f.customer, { test_clock: null });
      if (missing === 'clock-live') f.clock.livemode = true;
      if (missing === 'unready') f.clock.status = 'advancing';
      const observed = observeStripeTestClock(f.db, f.stripe, actualScope, mainland, actualEnv);
      if (['environment', 'scope-live', 'order-live'].includes(missing)) await expect(observed).resolves.toBeNull();
      else await expect(observed).rejects.toThrow(missing === 'unready'
        ? 'PAY_STRIPE_TEST_CLOCK_NOT_READY' : 'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
      expect(f.rpc).not.toHaveBeenCalled();
    });
  it.each([
    { payment_method: 'card_cn', stripe_managed_payments: true },
    { payment_method: 'card_cn', stripe_managed_payments: null },
    { payment_method: 'card', stripe_managed_payments: false },
    { payment_method: 'wechat_pay', stripe_managed_payments: false },
  ])('never observes a mismatched method/MP pair: %j', async patch => {
    const f = fixture();
    expect(await observeStripeTestClock(f.db, f.stripe, scope, { ...order, ...patch }, env)).toBeNull();
    expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('does not treat a persistence failure as an accepted observation', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { message: 'scope denied' } });
    await expect(observeStripeTestClock(f.db, f.stripe, scope, order, env)).rejects.toThrow('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  });
  it('resolves a checkout-action renewal through source_order_id before observing the original frozen customer', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const f = fixture();
    const renewal = { ...order, id: 'renewal', source_order_id: order.id, purchase_action: 'checkout', checkout_request: null };
    const responses = [renewal, order];
    const filters: Array<[string, unknown]> = [];
    const from = vi.fn(() => {
      const response = responses.shift();
      const q = { select: vi.fn(), eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return q; }),
        maybeSingle: vi.fn(async () => ({ data: response, error: null })) };
      q.select.mockReturnValue(q); return q;
    });
    const db = { from, rpc: f.rpc } as unknown as SupabaseClient;
    await expect(refreshStripeTestClockOrder(db, f.stripe, scope, 'renewal')).resolves.toMatchObject({
      customerId: f.customer.id, clockId: f.clock.id });
    expect(filters).toEqual([['id', 'renewal'], ['id', order.id], ['user_id', order.user_id]]);
    expect(f.rpc).toHaveBeenCalledWith('pay_stripe_test_clock_observe', expect.objectContaining({ p_order: order.id }));
    expect(f.customers.retrieve).toHaveBeenCalledExactlyOnceWith(f.customer.id);
  });
  it.each(['environment', 'live'])('does no DB or provider work while refreshing an order on the ordinary %s path', async reason => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    if (reason === 'environment') vi.stubEnv('VERCEL_ENV', 'preview');
    const f = fixture();
    await expect(refreshStripeTestClockOrder(f.db, f.stripe, reason === 'live' ? { ...scope, mode: 'live' } : scope, order.id)).resolves.toBeNull();
    expect(f.from).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.customers.retrieve).not.toHaveBeenCalled();
  });
  it.each(['card', 'card_cn'])('returns only database-authoritative times after all %s provider observations', async method => {
    const f = fixture();
    f.sources[0] = { ...order, payment_method: method, stripe_managed_payments: method === 'card' };
    f.rpc.mockImplementation(async (name: string) => ({ data: name === 'pay_stripe_test_clock_times'
      ? [{ orderId: 'order', now: '2026-11-21T12:00:00Z' }, { orderId: 'renewal', now: '2026-11-21T12:00:00Z' }] : null, error: null }));
    const times = await refreshStripeTestClockUser(f.db, 'owner', env, f.stripe);
    expect([...times]).toEqual([['order', Date.parse('2026-11-21T12:00:00Z')], ['renewal', Date.parse('2026-11-21T12:00:00Z')]]);
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['pay_stripe_test_clock_observe', 'pay_stripe_test_clock_times']);
  });
  it('avoids provider reads when no frozen test-clock source exists', async () => {
    const f = fixture(); f.sources.length = 0;
    await expect(refreshStripeTestClockUser(f.db, 'owner', env, f.stripe)).resolves.toEqual(new Map());
    expect(resolveScope).not.toHaveBeenCalled(); expect(f.customers.retrieve).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it('fails closed on malformed database clock time', async () => {
    const f = fixture(); f.rpc.mockImplementation(async (name: string) => ({ data: name === 'pay_stripe_test_clock_times'
      ? [{ orderId: 'order', now: 'not-a-date' }] : null, error: null }));
    await expect(refreshStripeTestClockUser(f.db, 'owner', env, f.stripe)).rejects.toThrow('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  });
});
