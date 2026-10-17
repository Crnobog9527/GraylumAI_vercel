/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { inferRouterContext } from '@trpc/server';
import { router as createTRPCRouter } from '../trpc';
import { methodPaymentProcedures } from './methodPayments';
import { logger } from '../lib/logger';
import { WaffoFailure } from '../services/payments/waffoFailure';
import { RateLimitError } from '../lib/rateLimitError';
import { assertCheckoutRateLimit } from '../services/stripe';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), provider: vi.fn(), wallet: vi.fn(), card: vi.fn(), gateOpen: { value: false } }));
vi.mock('../services/payments/waffoTestOperationsClient', () => ({ getWaffoTestOperationsClient: mocks.provider }));
// Every new checkout is closed in code during PR-1; the error-mapping tests open the gate explicitly.
vi.mock('../services/payments/methodCheckoutGate', async (load) => {
  const real = await load<typeof import('../services/payments/methodCheckoutGate')>();
  return { ...real, assertMethodCheckoutEnvironment: (env: Record<string, string | undefined>, method: 'card') => {
    if (!mocks.gateOpen.value) real.assertMethodCheckoutEnvironment(env, method);
  } };
});
vi.mock('../services/payments/walletCheckout', () => ({ createWalletCheckout: mocks.wallet }));
vi.mock('../services/payments/stripeMethodCheckout', () => ({ createStripeCardCheckout: mocks.card }));
vi.mock('../services/stripe', () => ({ assertCheckoutRateLimit: vi.fn(), getStripeAppUrl: () => 'https://auth-staging.graylum.com',
  getStripeClient: vi.fn() }));
const router = createTRPCRouter(methodPaymentProcedures);
const userId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-000000000002';
function fixture(role = 'user', settings?: Record<string, unknown>, unpaidSubscriptions?: unknown[]) {
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
    if (table === 'user_subscriptions' && unpaidSubscriptions) {
      const chain = { select: () => chain, eq: () => chain, in: () => chain, limit: async () => ({ data: unpaidSubscriptions, error: null }) };
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
  mocks.wallet.mockReset().mockResolvedValue({ orderId: 'order', state: 'open', url: 'https://checkout.stripe.com/c/pay/x' });
  mocks.card.mockReset().mockResolvedValue({ orderId: 'card-order', state: 'open', url: 'https://checkout.stripe.com/c/pay/card' });
  mocks.gateOpen.value = false;
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
const wallet = { ...card, method: 'wechat_pay', offer: 'standard' } as const;
const routes = (enabled: boolean) => ({ version: 4, card: { enabled }, card_cn: { enabled },
  wechat_pay: { enabled, annualVerified: true }, alipay: { enabled, annualVerified: true } });
const settings = (enabled: boolean) => ({ payment_method_routes: routes(enabled), payment_terms_version: { version: 'terms-test' } });
function stubStaging(production = 'auth-staging.graylum.com') {
  const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', VERCEL_PROJECT_ID: 'synthetic-staging-project',
  V3_RUNTIME_STAGING_PROJECT_ID: 'synthetic-staging-project', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'synthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001', WAFFO_TEST_OPERATIONS_ENABLED: 'true' };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', production);
}
it('keeps every card checkout closed in production even with every switch on, and on staging while the switch is off', async () => {
  for (const [host, enabled] of [['app.graylum.com', true], ['auth-staging.graylum.com', false]] as const) {
    stubStaging(host);
    for (const method of ['card', 'card_cn'] as const) {
      const f = fixture('user', settings(enabled));
      await expect(f.caller.methodCheckout({ ...card, method })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(f.rpc).not.toHaveBeenCalled();
    }
  }
  expect(mocks.wallet).not.toHaveBeenCalled(); expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it('passes a checkout rate limit through as TOO_MANY_REQUESTS with its retry hint, not as a generic failure', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  vi.mocked(assertCheckoutRateLimit).mockRejectedValueOnce(new RateLimitError('rate_limited', 30));
  await expect(fixture('user', settings(true)).caller.methodCheckout(card)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS',
    message: '请求过于频繁，请在 30 秒后重试' });
  expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.wallet).not.toHaveBeenCalled();
});
it('sends card purchases past the environment gate to the Stripe card checkout, never Waffo or the wallet checkout', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  for (const method of ['card', 'card_cn'] as const) {
    await expect(fixture('user', settings(true)).caller.methodCheckout({ ...card, method }))
      .resolves.toEqual({ orderId: 'card-order', state: 'open', url: 'https://checkout.stripe.com/c/pay/card', checkoutValue: null });
    expect(mocks.card).toHaveBeenLastCalledWith(expect.objectContaining({ purchase: { ...card, method } }));
  }
  await expect(fixture('user', settings(false)).caller.methodCheckout(card)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(mocks.card).toHaveBeenCalledTimes(2);
  expect(mocks.wallet).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it('keeps GA ids out of the purchase and stores only well-formed ones beside the opened order (ANALYTICS 0286)', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  const f = fixture('user', settings(true));
  const analytics = { clientId: '123456789.1700000000', sessionId: '1700000000' };
  await expect(f.caller.methodCheckout({ ...card, analytics })).resolves.toMatchObject({ orderId: 'card-order', state: 'open' });
  expect(mocks.card).toHaveBeenLastCalledWith(expect.objectContaining({ purchase: card }));
  expect(JSON.stringify(mocks.card.mock.lastCall)).not.toContain('1700000000');
  expect(f.rpc).toHaveBeenCalledWith('analytics_store_checkout_ids', { p_user: userId, p_order: 'card-order',
    p_client: analytics.clientId, p_session: analytics.sessionId });
  // Forged values never refuse the purchase and are never stored.
  const forged = fixture('user', settings(true));
  await expect(forged.caller.methodCheckout({ ...card, analytics: { clientId: 'someone@example.com', sessionId: 'x' } }))
    .resolves.toMatchObject({ state: 'open' });
  expect(forged.rpc).not.toHaveBeenCalledWith('analytics_store_checkout_ids', expect.anything());
  // A failed store is statistics only: the checkout still opens.
  const failing = fixture('user', settings(true));
  failing.rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
  await expect(failing.caller.methodCheckout({ ...card, analytics })).resolves.toMatchObject({ state: 'open' });
  // Without ids, or when the checkout did not open, nothing is stored.
  const none = fixture('user', settings(true));
  await none.caller.methodCheckout(card);
  mocks.card.mockResolvedValueOnce({ orderId: 'card-order', state: 'recovery_required', url: null });
  await none.caller.methodCheckout({ ...card, analytics });
  expect(none.rpc).not.toHaveBeenCalledWith('analytics_store_checkout_ids', expect.anything());
  await expect(none.caller.methodCheckout({ ...card, extra: 1 } as typeof card)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
it('checks the route switch and version before the wallet checkout', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  await expect(fixture('user', settings(false)).caller.methodCheckout(wallet)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  await expect(fixture('user', settings(true)).caller.methodCheckout({ ...wallet, routingVersion: 3 }))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(mocks.wallet).not.toHaveBeenCalled();
  await expect(fixture('user', settings(true)).caller.methodCheckout(wallet))
    .resolves.toEqual({ orderId: 'order', state: 'open', url: 'https://checkout.stripe.com/c/pay/x', checkoutValue: null });
  expect(mocks.wallet).toHaveBeenCalledWith(expect.objectContaining({ userId, termsVersion: 'terms-test', purchase: wallet }));
});
it('does not open Stripe wallets while the code gate is closed', async () => {
  stubStaging();
  const f = fixture('user', settings(true));
  await expect(f.caller.methodCheckout(wallet)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(f.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('logs the secret-free failure reason that the generic 503 hides', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  mocks.wallet.mockRejectedValueOnce(new WaffoFailure('PAY_WAFFO_PROVIDER_UNAVAILABLE', { category: 'timeout',
    path: '/v1/checkout/sessions', errorName: 'TimeoutError' }));
  await expect(fixture('user', settings(true)).caller.methodCheckout(wallet))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '暂时无法创建付款，请稍后查看原订单状态' });
  expect(error).toHaveBeenCalledWith('billing', 'pay_waffo_method_failed', { operation: 'method_checkout', userId,
    method: 'wechat_pay', code: 'PAY_WAFFO_PROVIDER_UNAVAILABLE', category: 'timeout', path: '/v1/checkout/sessions',
    errorName: 'TimeoutError' });
  error.mockRestore();
});
it('answers an expected admission refusal with a typed error and plain message, not a 503', async () => {
  stubStaging(); mocks.gateOpen.value = true;
  const { MethodPurchaseRejected } = await import('../services/payments/methodPurchaseError');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  mocks.wallet.mockRejectedValueOnce(new MethodPurchaseRejected('PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED'));
  await expect(fixture('user', settings(true)).caller.methodCheckout(wallet)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED', message: '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。' });
  mocks.wallet.mockRejectedValueOnce(new MethodPurchaseRejected('PAY_WAFFO_GOLD_FIRST_INELIGIBLE'));
  await expect(fixture('user', settings(true)).caller.methodCheckout(wallet)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED', message: expect.stringContaining('首月优惠仅限首次购买') });
  // A subscription whose payment failed (past_due / incomplete) is refused with the same code, in words that say what
  // to do (same as the purchase page and profile notice, #937).
  mocks.wallet.mockRejectedValueOnce(new MethodPurchaseRejected('PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED'));
  await expect(fixture('user', settings(true), [{ id: 'sub-past-due' }]).caller.methodCheckout(wallet)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED', message: '你还有一个付款没有成功的订阅（例如自动续费扣款失败）。为避免重复扣费，暂时不能购买新的套餐。'
      + '请提交工单，我们帮你停止这个订阅或补上付款，处理好后就能重新购买。' });
  mocks.wallet.mockRejectedValueOnce(new MethodPurchaseRejected('PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED'));
  await expect(fixture('user', settings(true), []).caller.methodCheckout(wallet)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED', message: '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。' });
  // The same code text without the admission marker (e.g. a server fault) is still a 503.
  mocks.wallet.mockRejectedValueOnce(new Error('PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED'));
  await expect(fixture('user', settings(true)).caller.methodCheckout(wallet)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(warn).toHaveBeenCalledWith('billing', 'pay_waffo_method_failed', expect.objectContaining({
    operation: 'method_checkout', code: 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED' }));
  warn.mockRestore();
});
