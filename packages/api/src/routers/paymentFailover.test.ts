/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { router } from '../trpc';
import { setPaymentFailover, assertNoFailoverChange } from './paymentFailover';
const id = '33333333-3333-4333-8333-333333333333';
const routes = { version: 7, card: { enabled: true }, alipay: { enabled: true, annualVerified: false },
  wechat_pay: { enabled: false, annualVerified: false }, newPurchaseChannel: 'waffo' };
const testRouter = router({ setPaymentFailover });
const rpc = vi.fn();
function caller(role: string, loggedIn = true) {
  const profile = { id, role, status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => ({ select() { return this; }, eq() { return this; },
    single: async () => ({ data: profile, error: null }) }) };
  return testRouter.createCaller({ headers: new Headers(),
    user: loggedIn ? { id, app_metadata: {}, user_metadata: {} } : null,
    isEmailVerified: true, authProvider: 'email', supabase: scoped, supabaseAuth: scoped,
    supabasePublic: {}, supabaseAdmin: { rpc }, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
}
beforeEach(() => { rpc.mockReset().mockResolvedValue({ data: routes, error: null }); });
it('uses the authenticated admin and the expected version in the audited SQL transaction', async () => {
  expect(await caller('admin').setPaymentFailover({ channel: 'waffo', expectedVersion: 6 })).toEqual(routes);
  expect(rpc).toHaveBeenCalledExactlyOnceWith('pay_failover_set_channel', { p_actor: id, p_version: 6, p_channel: 'waffo' });
});
it.each(['user', 'anonymous'])('rejects %s before touching the switch', async role => {
  await expect(caller(role, role !== 'anonymous').setPaymentFailover({ channel: 'waffo', expectedVersion: 6 })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('returns a version conflict instead of retrying a concurrent switch', async () => {
  rpc.mockResolvedValue({ data: null, error: { code: 'PT409' } });
  await expect(caller('admin').setPaymentFailover({ channel: 'stripe', expectedVersion: 6 })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(rpc).toHaveBeenCalledOnce();
});
it('blocks generic settings changes of the channel but allows retaining it', async () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { value: routes }, error: null }) };
  const db = { from: () => q } as never;
  await expect(assertNoFailoverChange(db, [{ key: 'payment_method_routes', value: { ...routes, newPurchaseChannel: 'stripe' } }]))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(assertNoFailoverChange(db, [{ key: 'payment_method_routes', value: { ...routes, version: 8 } }])).resolves.toBeUndefined();
});
