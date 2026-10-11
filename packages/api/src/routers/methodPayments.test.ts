/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { inferRouterContext } from '@trpc/server';
import { router as createTRPCRouter } from '../trpc';
import { methodPaymentProcedures } from './methodPayments';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), provider: vi.fn() }));
vi.mock('../services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.provider }));
const router = createTRPCRouter(methodPaymentProcedures);
const userId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-000000000002';
function fixture(role = 'user') {
  const profile = { id: userId, nickname: 'Fixture', role, status: 'active', is_deleted: 'false', membership_level: 'free', email: 'fixture@example.test' };
  const rpc = vi.fn().mockResolvedValue({ error: null, data: { dispatch: true, subscriptionId,
    providerId: 'ORD_original', merchant: 'fixture', mode: 'test' } });
  const from = vi.fn((table: string) => {
    if (table !== 'profiles') throw new Error('Unexpected settings/provider lookup while checkout is closed');
    const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: profile, error: null }) };
    return chain;
  });
  const db = { from, rpc };
  const context = { headers: new Headers(), user: { id: userId, email: profile.email,
    app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } }, isEmailVerified: true,
    authProvider: 'email', hasSupabaseAdminPrivileges: true, supabase: db, supabasePublic: db, supabaseAdmin: db,
  } as unknown as inferRouterContext<typeof router>;
  return { caller: router.createCaller(context), from, rpc };
}
beforeEach(() => {
  mocks.cancel.mockReset().mockResolvedValue({ orderId: 'ORD_original', status: 'canceling' });
  mocks.provider.mockReset().mockReturnValue({ merchant: 'fixture', mode: 'test', cancelSubscription: mocks.cancel });
});
it('keeps public checkout closed before any configuration, order or provider access', async () => {
  const f = fixture();
  await expect(f.caller.methodCheckout({ itemType: 'membership_plan', itemId: subscriptionId, billingCycle: 'monthly',
    method: 'alipay', offer: 'standard', acceptedTerms: true, routingVersion: 1, termsVersion: 'terms-test' }))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(f.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true);
  expect(f.rpc).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it('binds cancellation to authenticated actor, independently of the new-sale gate', async () => {
  const f = fixture();
  await expect(f.caller.methodCancel({ subscriptionId })).resolves.toEqual({ state: 'confirmed' });
  expect(f.rpc).toHaveBeenCalledWith('pay_waffo_cancel_intent', { p_user: userId, p_subscription: subscriptionId });
  expect(mocks.cancel).toHaveBeenCalledWith('ORD_original');
});
it('rejects ordinary-user product controls before provider access', async () => {
  const f = fixture();
  await expect(f.caller.methodProductControl({ priceRefId: subscriptionId, blocked: true, expectedVersion: 0 }))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.rpc).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
