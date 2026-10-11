/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), prepare: vi.fn(), build: vi.fn(), dispatch: vi.fn() }));
vi.mock('./methodPurchase', () => ({ prepareMethodPurchase: mocks.prepare }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./stripeCheckoutIntent', () => ({ buildStripeCheckoutRequest: mocks.build, dispatchStripeCheckoutIntent: mocks.dispatch }));
import { createWalletCheckout } from './walletCheckout';
const id = '00000000-0000-4000-8000-000000000001';
function fixture(dispatch = true) {
  const rpc = vi.fn().mockResolvedValue({ data: { dispatch, request: { providerRequest: { original: true } } }, error: null });
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn()
    .mockResolvedValueOnce({ data: { external_id: 'price_1' }, error: null })
    .mockResolvedValueOnce({ data: null, error: null }) };
  const db = { from: vi.fn(() => chain), rpc } as unknown as SupabaseClient;
  const input = { db, stripe: {} as Stripe, userId: id, appUrl: 'https://test.invalid', termsVersion: 'terms-test',
    purchase: { itemType: 'membership_plan' as const, itemId: id, billingCycle: 'monthly' as const,
      method: 'alipay' as const, offer: 'standard' as const, acceptedTerms: true as const, routingVersion: 1 } };
  return { input, rpc, chain };
}
describe('durable wallet checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.mockResolvedValue({ merchant: 'fixture', mode: 'test' });
    mocks.prepare.mockResolvedValue({ id, price_ref_id: id, purchase_snapshot: {} });
    mocks.build.mockReturnValue({ proposed: true });
    mocks.dispatch.mockResolvedValue({ id: 'cs_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/test' });
  });
  it('dispatches only after persistent claim and recovers the frozen request on retry', async () => {
    const f = fixture(false); const before = Math.floor(Date.now() / 1000); await createWalletCheckout(f.input);
    expect(mocks.build.mock.calls[0]?.[0].expiresAt).toBeLessThanOrEqual(before + 31 * 60);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: false,
      closeBeforeDispatch: undefined, intent: expect.objectContaining({ id, recover: true, walletMethod: 'alipay', request: { original: true } }) }));
  });
  it('retains Stripe minimum expiry after a delayed database claim', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2028-01-01T00:00:00Z'));
    try {
      const f = fixture();
      mocks.build.mockImplementation((input) => ({ expires_at: input.expiresAt }));
      f.rpc.mockImplementation(async (_name, args) => {
        vi.setSystemTime(new Date(Date.now() + 8000));
        return { data: { dispatch: true, request: args.p_request }, error: null };
      });
      mocks.dispatch.mockImplementation(async ({ intent }) => {
        expect(intent.request.expires_at - Math.floor(Date.now() / 1000)).toBe(31 * 60 - 8);
        expect(intent.request.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
        return { id: 'cs_1', status: 'open', url: 'https://checkout.stripe.com/c/pay/test' };
      });
      await createWalletCheckout(f.input);
    } finally { vi.useRealTimers(); }
  });
  it('closes the original claim when the adapter proves it stopped before Session creation', async () => {
    const f = fixture(); const expires = Math.floor(Date.now() / 1000) + 31 * 60;
    f.rpc.mockResolvedValueOnce({ data: { dispatch: true, request: { providerRequest: { expires_at: expires } } }, error: null });
    mocks.dispatch.mockImplementation(async (input) => { await input.closeBeforeDispatch(); return null; });
    expect((await createWalletCheckout(f.input)).state).toBe('recovery_required');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_abort_before_dispatch', { p_user: id, p_order: id,
      p_merchant: 'fixture', p_expected: new Date(expires * 1000).toISOString() });
  });
  it.each([true, false])('releases a failed mapping read only for the fresh claim: %s', async (dispatch) => {
    const f = fixture(dispatch); const expires = Math.floor(Date.now() / 1000) + 31 * 60;
    f.rpc.mockResolvedValueOnce({ data: { dispatch, request: { providerRequest: { expires_at: expires } } }, error: null });
    f.chain.maybeSingle.mockReset().mockResolvedValueOnce({ data: { external_id: 'price_1' }, error: null })
      .mockRejectedValueOnce(new Error('mapping read unavailable'));
    await expect(createWalletCheckout(f.input)).rejects.toThrow('CHECKOUT_UNAVAILABLE');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.filter(([name]) => name === 'pay_waffo_abort_before_dispatch')).toHaveLength(dispatch ? 1 : 0);
  });
  it('does not call the provider after claim failure or live scope', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ error: { message: 'unavailable' }, data: null });
    await expect(createWalletCheckout(f.input)).rejects.toThrow('CHECKOUT_UNAVAILABLE');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.scope.mockResolvedValue({ merchant: 'fixture', mode: 'live' });
    await expect(createWalletCheckout(f.input)).rejects.toThrow('LIVE_DISABLED');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('propagates uncertain results without retrying', async () => {
    const f = fixture(); mocks.dispatch.mockRejectedValue(new Error('timeout'));
    await expect(createWalletCheckout(f.input)).rejects.toThrow('timeout');
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
