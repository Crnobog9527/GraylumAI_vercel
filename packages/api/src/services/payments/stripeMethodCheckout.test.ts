/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), prepare: vi.fn(), build: vi.fn(), dispatch: vi.fn(), settle: vi.fn() }));
vi.mock('./methodOrderSettle', () => ({ settleBuyerOrders: mocks.settle }));
vi.mock('./methodPurchase', () => ({ prepareMethodPurchase: mocks.prepare }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./stripeCheckoutIntent', () => ({ buildStripeCheckoutRequest: mocks.build, dispatchStripeCheckoutIntent: mocks.dispatch }));
import { createStripeCardCheckout } from './stripeMethodCheckout';
import { MethodPurchaseRejected } from './methodPurchaseError';

const id = '00000000-0000-4000-8000-000000000001';
const plan = '00000000-0000-4000-8000-000000000002';
const snapshot = (discount: string) => ({ version: 1, item_type: 'membership_plan', item_id: plan,
  item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '69.00',
  discount, tax_behavior: 'exclusive', credits: 8970, bonus_credits: 0 });
function fixture(method: 'card' | 'card_cn', coupon: { external_id: string } | null = { external_id: 'coupon_first' },
  claim: { dispatch: boolean; frozenCoupon?: string | null } = { dispatch: true }) {
  const frozen = claim.frozenCoupon === undefined ? coupon?.external_id : claim.frozenCoupon;
  const providerRequest = { expires_at: 9999999999, ...(frozen ? { discounts: [{ coupon: frozen }] } : {}) };
  const rpc = vi.fn().mockResolvedValue({ data: { dispatch: claim.dispatch, request: { providerRequest } }, error: null });
  const eq = vi.fn(() => chain);
  const chain = { select: vi.fn(() => chain), eq, maybeSingle: vi.fn()
    .mockResolvedValueOnce({ data: { external_id: 'price_gold_month' }, error: null })
    .mockResolvedValueOnce({ data: coupon, error: null })
    .mockResolvedValueOnce({ data: null, error: null }) };
  const db = { from: vi.fn(() => chain), rpc } as unknown as SupabaseClient;
  const input = { db, stripe: {} as Stripe, userId: id, appUrl: 'https://test.invalid', termsVersion: 'terms-test',
    purchase: { itemType: 'membership_plan' as const, itemId: plan, billingCycle: 'monthly' as const, method,
      offer: 'gold_first30' as const, acceptedTerms: true as const, routingVersion: 1 } };
  return { input, rpc, eq };
}
describe('PAY-STRIPE-MP card checkout adapter', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.mockResolvedValue({ merchant: 'fixture', mode: 'test' });
    mocks.prepare.mockResolvedValue({ id, item_id: plan, price_ref_id: id, purchase_snapshot: snapshot('20.00') });
    mocks.build.mockReturnValue({ proposed: true });
    mocks.dispatch.mockResolvedValue({ id: 'cs_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/test' });
    mocks.settle.mockResolvedValue(false);
  });
  it('applies the plan\'s current first-month coupon; MP only for the international card', async () => {
    for (const method of ['card', 'card_cn'] as const) {
      const f = fixture(method);
      await expect(createStripeCardCheckout(f.input)).resolves.toMatchObject({ state: 'open' });
      const card = { managedPayments: method === 'card', couponId: 'coupon_first' };
      expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ card, walletMethod: undefined }));
      expect(mocks.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ intent: expect.objectContaining({ card }) }));
      expect(f.eq).toHaveBeenCalledWith('offer_kind', 'gold_first30');
      expect(f.eq).toHaveBeenCalledWith('membership_plan_id', plan);
      expect(f.eq).toHaveBeenCalledWith('is_current', true);
    }
  });
  it('accepts only a user-owned, test-clock Stripe customer on the exact staging preview', async () => {
    for (const [key, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
      VERCEL_GIT_COMMIT_REF: 'codex/stripe-test-clock-checkout', VERCEL_GIT_REPO_OWNER: 'Crnobog9527',
      VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true',
      V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
      V3_RUNTIME_STAGING_DATABASE_HOST: 'staging.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co' })) {
      vi.stubEnv(key, value);
    }
    const f = fixture('card');
    const customerId = 'cus_clockcustomer123';
    const retrieve = vi.fn().mockResolvedValue({ id: customerId, object: 'customer', livemode: false,
      metadata: { graylum_user_id: id }, test_clock: 'clock_fixture' });
    const checkoutInput = { ...f.input, stripeTestClockCustomerId: customerId };
    checkoutInput.stripe = { customers: { retrieve } } as unknown as Stripe;
    f.rpc.mockResolvedValue({ data: { dispatch: true, request: { providerRequest: { expires_at: 9999999999,
      discounts: [{ coupon: 'coupon_first' }], customer: customerId } } }, error: null });

    await expect(createStripeCardCheckout(checkoutInput)).resolves.toMatchObject({ state: 'open' });
    expect(retrieve).toHaveBeenCalledWith(customerId);
    expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ testClockCustomerId: customerId,
      card: expect.objectContaining({ testClockCustomerId: customerId }) }));
  });
  it('refuses a Stripe test customer owned by another account before reserving an order', async () => {
    for (const [key, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
      VERCEL_GIT_COMMIT_REF: 'codex/stripe-test-clock-checkout', VERCEL_GIT_REPO_OWNER: 'Crnobog9527',
      VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel', STRIPE_TEST_CLOCK_CHECKOUT_ENABLED: 'true',
      V3_RUNTIME_STAGING_PROJECT_ID: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
      V3_RUNTIME_STAGING_DATABASE_HOST: 'staging.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co' })) {
      vi.stubEnv(key, value);
    }
    const f = fixture('card');
    const retrieve = vi.fn().mockResolvedValue({ id: 'cus_clockcustomer123', object: 'customer', livemode: false,
      metadata: { graylum_user_id: 'another-user' }, test_clock: 'clock_fixture' });
    const checkoutInput = { ...f.input, stripeTestClockCustomerId: 'cus_clockcustomer123' };
    checkoutInput.stripe = { customers: { retrieve } } as unknown as Stripe;

    await expect(createStripeCardCheckout(checkoutInput)).rejects.toThrow('PAY_WAFFO_TEST_CLOCK_CUSTOMER_DENIED');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('refuses without a current coupon before claiming or calling Stripe, releasing the never-claimed order', async () => {
    const f = fixture('card', null);
    await expect(createStripeCardCheckout(f.input)).rejects.toThrow('PAY_WAFFO_PRICE_UNAVAILABLE');
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_abort_before_dispatch', { p_user: id, p_order: id, p_merchant: 'fixture',
      p_expected: null });
    expect(mocks.build).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    const failed = fixture('card', null); failed.rpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    await expect(createStripeCardCheckout(failed.input)).rejects.toThrow('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  });
  it('recovers with the coupon frozen at dispatch even after the current mapping rotated', async () => {
    const f = fixture('card', { external_id: 'coupon_new' }, { dispatch: false, frozenCoupon: 'coupon_old' });
    await expect(createStripeCardCheckout(f.input)).resolves.toMatchObject({ state: 'open' });
    expect(mocks.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ createIfMissing: false,
      intent: expect.objectContaining({ card: { managedPayments: true, couponId: 'coupon_old' }, recover: true }) }));
  });
  it('recovers a dispatched order from its frozen request even when no coupon mapping is current', async () => {
    const providerRequest = { expires_at: 9999999999, discounts: [{ coupon: 'coupon_rolled_back' }] };
    mocks.prepare.mockResolvedValue({ id, item_id: plan, price_ref_id: id, purchase_snapshot: snapshot('20.00'),
      method_dispatched_at: '2026-10-13T00:00:00Z', checkout_request: { providerRequest } });
    const f = fixture('card', null, { dispatch: false, frozenCoupon: 'coupon_rolled_back' });
    await expect(createStripeCardCheckout(f.input)).resolves.toMatchObject({ state: 'open' });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(f.eq).not.toHaveBeenCalledWith('object_type', 'coupon');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_claim_checkout', expect.objectContaining({
      p_request: expect.objectContaining({ providerRequest }) }));
    expect(mocks.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ createIfMissing: false,
      intent: expect.objectContaining({ card: { managedPayments: true, couponId: 'coupon_rolled_back' }, recover: true }) }));
  });
  it('refuses a fresh claim whose frozen coupon differs from the one just selected', async () => {
    const f = fixture('card', { external_id: 'coupon_new' }, { dispatch: true, frozenCoupon: 'coupon_old' });
    await expect(createStripeCardCheckout(f.input)).rejects.toThrow('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('reads no coupon for an undiscounted card purchase and refuses wallet methods', async () => {
    mocks.prepare.mockResolvedValue({ id, item_id: plan, price_ref_id: id, purchase_snapshot: snapshot('0.00') });
    await createStripeCardCheckout(fixture('card', null, { dispatch: true, frozenCoupon: null }).input);
    expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ card: { managedPayments: true } }));
    const wallet = fixture('card'); (wallet.input.purchase as { method: string }).method = 'alipay';
    await expect(createStripeCardCheckout(wallet.input)).rejects.toThrow('PAY_WAFFO_METHOD_DENIED');
  });
  it('binds only a session with the expected payment method shape', async () => {
    const sessions = [{ managed_payments: { enabled: true }, payment_method_types: ['card', 'link'] },
      { managed_payments: null, payment_method_types: ['card'] }, { managed_payments: null, payment_method_types: ['card', 'alipay'] }];
    const bound: boolean[] = [];
    for (const [method, session] of [['card', sessions[0]], ['card', sessions[1]], ['card_cn', sessions[1]], ['card_cn', sessions[2]],
      ['card_cn', sessions[0]]] as const) {
      const f = fixture(method);
      mocks.dispatch.mockImplementationOnce(async ({ persistSession }) => {
        await persistSession({ id: 'cs_1', expires_at: 9999999999, ...session }); return { status: 'open', url: 'https://checkout.stripe.com/x' };
      });
      bound.push(await createStripeCardCheckout(f.input).then(() => true, () => false));
    }
    expect(bound).toEqual([true, false, true, false, false]);
  });
  it('#961: another plan\'s order that can no longer be paid is closed (Stripe read first), then admission runs again', async () => {
    const pending = new MethodPurchaseRejected('PAY_WAFFO_PURCHASE_PENDING');
    const f = fixture('card');
    mocks.prepare.mockRejectedValueOnce(pending);
    mocks.settle.mockResolvedValueOnce(true);
    await expect(createStripeCardCheckout(f.input)).resolves.toMatchObject({ state: 'open' });
    expect(mocks.settle).toHaveBeenCalledWith(f.input.db, f.input.stripe, { merchant: 'fixture', mode: 'test' }, id);
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    // Still payable, paid, unreadable at Stripe, or claimed meanwhile by a concurrent retry: the buyer keeps the answer.
    mocks.prepare.mockReset().mockRejectedValue(pending);
    await expect(createStripeCardCheckout(fixture('card').input)).rejects.toBe(pending);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    mocks.settle.mockRejectedValueOnce(new Error('PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED'));
    await expect(createStripeCardCheckout(fixture('card').input)).rejects.toBe(pending);
    // Other refusals never trigger a close.
    mocks.prepare.mockReset().mockRejectedValue(new MethodPurchaseRejected('PAY_WAFFO_FOUNDER_SOLD_OUT'));
    mocks.settle.mockClear();
    await expect(createStripeCardCheckout(fixture('card').input)).rejects.toThrow('PAY_WAFFO_FOUNDER_SOLD_OUT');
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('#961: a failure after admission and before the claim releases the order instead of blocking other plans', async () => {
    const f = fixture('card');
    const chain = (f.input.db.from as unknown as () => { maybeSingle: ReturnType<typeof vi.fn> })();
    chain.maybeSingle.mockReset().mockResolvedValueOnce({ data: null, error: null });
    await expect(createStripeCardCheckout(f.input)).rejects.toThrow('PAY_WAFFO_PRICE_UNAVAILABLE');
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_abort_before_dispatch', { p_user: id, p_order: id, p_merchant: 'fixture',
      p_expected: null });
    // A dispatched order recovered by a retry is never released here: its session may exist at Stripe.
    mocks.prepare.mockResolvedValue({ id, item_id: plan, price_ref_id: id, purchase_snapshot: snapshot('20.00'),
      method_dispatched_at: '2026-10-13T00:00:00Z', checkout_request: { providerRequest: { expires_at: 9999999999 } } });
    const recovered = fixture('card');
    const again = (recovered.input.db.from as unknown as () => { maybeSingle: ReturnType<typeof vi.fn> })();
    again.maybeSingle.mockReset().mockResolvedValueOnce({ data: null, error: { message: 'read failed' } });
    await expect(createStripeCardCheckout(recovered.input)).rejects.toThrow('PAY_WAFFO_PRICE_UNAVAILABLE');
    expect(recovered.rpc).not.toHaveBeenCalled();
  });
});
