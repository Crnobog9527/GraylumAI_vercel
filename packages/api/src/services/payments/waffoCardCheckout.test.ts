/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./methodPurchase', async (original) => ({ ...await original<typeof import('./methodPurchase')>(), prepareMethodPurchase: mocks.prepare }));
import { createWaffoCardCheckout } from './waffoCardCheckout';
import { fakeDb } from './waffoTestHarness';

const id = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const sessionId = 'cs_73f87372-a33f-096f-e2e2-c8254e0062d1';
const order = { id, user_id: user, payment_mode: 'test', payment_channel: 'waffo', merchant_namespace: 'fixture', payment_method: 'card',
  offer_kind: 'standard', price_ref_id: 'ref-1', purchase_snapshot: { version: 1, item_type: 'membership_plan', item_id: id,
    item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
    price: '69.00', discount: '0.00', tax_behavior: 'inclusive', credits: 8970, bonus_credits: 0 } };
function setup(dispatch: boolean, session: unknown = {
  sessionId, checkoutUrl: `https://pay.test.invalid/checkout/${sessionId}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => (fn === 'pay_waffo_claim_checkout'
    ? { data: { dispatch, request: dispatch ? args.p_request : { providerRequest: { stored: true } } }, error: null }
    : { data: null, error: null }));
  const db = fakeDb({ payment_provider_refs: [{ id: 'ref-1', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test',
    object_type: 'price', external_id: 'PROD_gold' }] }, rpc);
  const provider = { merchant: 'fixture', mode: 'test' as const, createCheckout: vi.fn().mockResolvedValue(session) };
  const run = (origin: string | null = 'https://pay.test.invalid') => createWaffoCardCheckout({ db, provider, userId: user,
    appUrl: 'https://app.test.invalid', termsVersion: 'terms-1', checkoutOrigin: origin ?? undefined,
    purchase: { itemType: 'membership_plan', itemId: id, billingCycle: 'monthly', method: 'card', offer: 'standard',
      acceptedTerms: true, routingVersion: 1 } });
  return { rpc, provider, run };
}
describe('Waffo card checkout (normal path)', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.prepare.mockResolvedValue(order); });
  it('claims once, creates with a per-order idempotency key and binds the session', async () => {
    const f = setup(true);
    expect(await f.run()).toEqual({ orderId: id, state: 'open', url: `https://pay.test.invalid/checkout/${sessionId}` });
    const [request, key] = f.provider.createCheckout.mock.calls[0]!;
    expect(request).toMatchObject({ productId: 'PROD_gold', orderMerchantExternalId: id, includePaymentMethods: ['card'] });
    expect(key).toBe(`graylum-checkout-${id}`);
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_bind_checkout', expect.objectContaining({ p_checkout: sessionId }));
  });
  it('recovers a timed-out create by replaying the stored request with the same key', async () => {
    const f = setup(false);
    await f.run();
    expect(f.provider.createCheckout).toHaveBeenCalledWith({ stored: true }, `graylum-checkout-${id}`);
  });
  it('does not open a second checkout when the replayed session already expired', async () => {
    const f = setup(false, { sessionId, checkoutUrl: `https://pay.test.invalid/checkout/${sessionId}`,
      expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await f.run()).toEqual({ orderId: id, state: 'recovery_required', url: null });
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_bind_checkout', expect.anything());
  });
  it('fails closed before creating an order without the configured checkout origin or for other methods', async () => {
    await expect(setup(true).run(null)).rejects.toThrow('TEST_CONFIG_UNAVAILABLE');
    expect(mocks.prepare).not.toHaveBeenCalled();
    const foreign = setup(true, { sessionId, checkoutUrl: `https://evil.invalid/checkout/${sessionId}`,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    expect((await foreign.run()).state).toBe('recovery_required');
  });
});
