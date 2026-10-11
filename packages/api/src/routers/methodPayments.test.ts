/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { inferRouterContext } from '@trpc/server';
import { router as createTRPCRouter } from '../trpc';
import { methodPaymentProcedures } from './methodPayments';
import { logger } from '../lib/logger';
import { WaffoFailure } from '../services/payments/waffoFailure';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), provider: vi.fn(), card: vi.fn(), wallet: vi.fn() }));
vi.mock('../services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.provider }));
vi.mock('../services/payments/waffoCardCheckout', () => ({ createWaffoCardCheckout: mocks.card }));
vi.mock('../services/payments/walletCheckout', () => ({ createWalletCheckout: mocks.wallet }));
vi.mock('../services/stripe', () => ({ assertCheckoutRateLimit: vi.fn(), getStripeAppUrl: () => 'https://auth-staging.graylum.com',
  getStripeClient: vi.fn() }));
const router = createTRPCRouter(methodPaymentProcedures);
const userId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-000000000002';
function fixture(role = 'user', settings?: Record<string, unknown>) {
  const profile = { id: userId, nickname: 'Fixture', role, status: 'active', is_deleted: 'false', membership_level: 'free', email: 'fixture@example.test' };
  const rpc = vi.fn().mockResolvedValue({ error: null, data: { dispatch: true, subscriptionId,
    providerId: 'ORD_original', merchant: 'fixture', mode: 'test' } });
  const from = vi.fn((table: string) => {
    if (table === 'system_settings' && settings) {
      let key = '';
      const chain = { select: () => chain, eq: (_: string, value: string) => { key = value; return chain; },
        maybeSingle: async () => ({ data: key in settings ? { value: settings[key] } : null, error: null }) };
      return chain;
    }
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
afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(() => {
  mocks.card.mockReset().mockResolvedValue({ url: 'https://pancake.waffo.ai/store/s/checkout/c' }); mocks.wallet.mockReset();
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
const card = { itemType: 'membership_plan', itemId: subscriptionId, billingCycle: 'monthly', method: 'card',
  offer: 'gold_first30', acceptedTerms: true, routingVersion: 4, termsVersion: 'terms-test' } as const;
const routes = (enabled: boolean) => ({ version: 4, card: { enabled },
  wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } });
const settings = (enabled: boolean) => ({ payment_method_routes: routes(enabled), payment_terms_version: { version: 'terms-test' } });
function stubStaging(production = 'auth-staging.graylum.com') {
  vi.stubEnv('VERCEL', '1'); vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', production);
  vi.stubEnv('WAFFO_TEST_OPERATIONS_ENABLED', 'true');
}
it('keeps card checkout closed in production even with every switch on', async () => {
  stubStaging('app.graylum.com');
  const f = fixture('user', settings(true));
  await expect(f.caller.methodCheckout(card)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(f.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true);
  expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it('keeps staging card checkout closed while the card route switch is off', async () => {
  stubStaging();
  const f = fixture('user', settings(false));
  await expect(f.caller.methodCheckout(card)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it('opens staging test card checkout only with the current route version', async () => {
  stubStaging();
  await expect(fixture('user', settings(true)).caller.methodCheckout({ ...card, routingVersion: 3 }))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(mocks.card).not.toHaveBeenCalled();
  await expect(fixture('user', settings(true)).caller.methodCheckout(card))
    .resolves.toEqual({ url: 'https://pancake.waffo.ai/store/s/checkout/c' });
  expect(mocks.card).toHaveBeenCalledWith(expect.objectContaining({ userId, termsVersion: 'terms-test', purchase: card }));
});
it('does not open Stripe wallets through the card test switch', async () => {
  stubStaging();
  const f = fixture('user', settings(true));
  await expect(f.caller.methodCheckout({ ...card, method: 'wechat_pay', offer: 'standard' }))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(f.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('logs the secret-free failure reason that the generic 503 hides', async () => {
  stubStaging();
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  mocks.card.mockRejectedValueOnce(new WaffoFailure('PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: 'timeout',
    path: '/v1/actions/checkout/create-session', errorName: 'TimeoutError' }));
  await expect(fixture('user', settings(true)).caller.methodCheckout(card))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '暂时无法创建付款，请稍后查看原订单状态' });
  expect(error).toHaveBeenCalledWith('billing', 'pay_waffo_method_failed', { operation: 'method_checkout', userId, method: 'card',
    code: 'PAY_WAFFO_PROVIDER_UNAVAILABLE', category: 'timeout', path: '/v1/actions/checkout/create-session', errorName: 'TimeoutError' });
  error.mockRestore();
});
