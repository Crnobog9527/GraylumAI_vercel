/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./methodPurchase', async (original) => ({ ...await original<typeof import('./methodPurchase')>(), prepareMethodPurchase: mocks.prepare }));
import { closeExpiredWaffoCheckouts, createWaffoCardCheckout } from './waffoCardCheckout';
import { fakeDb } from './waffoTestHarness';

const id = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const sessionId = 'cs_73f87372-a33f-096f-e2e2-c8254e0062d1';
const order = { id, user_id: user, payment_mode: 'test', payment_channel: 'waffo', merchant_namespace: 'fixture', payment_method: 'card',
  offer_kind: 'standard', price_ref_id: 'ref-1', purchase_snapshot: { version: 1, item_type: 'membership_plan', item_id: id,
    item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
    price: '69.00', discount: '0.00', tax_behavior: 'inclusive', credits: 8970, bonus_credits: 0 } };
let claimLeft = 600_000;
function setup(dispatch: boolean, session: unknown = {
  sessionId, checkoutUrl: `https://pay.test.invalid/checkout/${sessionId}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => (fn === 'pay_waffo_claim_checkout'
    ? { data: { dispatch, request: dispatch ? args.p_request : { providerRequest: { stored: true } },
      expiresAt: dispatch ? args.p_expires : new Date(Date.now() + claimLeft).toISOString() }, error: null }
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
  beforeEach(() => { vi.clearAllMocks(); claimLeft = 600_000; mocks.prepare.mockResolvedValue(order); });
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
  it('never POSTs again once the original checkout window has passed', async () => {
    claimLeft = 30_000;
    const f = setup(false);
    expect(await f.run()).toEqual({ orderId: id, state: 'recovery_required', url: null });
    expect(f.provider.createCheckout).not.toHaveBeenCalled();
  });
  it('releases the order at once when Waffo definitively rejects the create request', async () => {
    const f = setup(true);
    f.provider.createCheckout.mockRejectedValue(new Error('PAY_WAFFO_PROVIDER_REJECTED'));
    await expect(f.run()).rejects.toThrow('PROVIDER_REJECTED');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_close_card_checkout', { p_user: user, p_order: id, p_merchant: 'fixture', p_rejected: true });
    const timeout = setup(true);
    timeout.provider.createCheckout.mockRejectedValue(new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE'));
    await expect(timeout.run()).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(timeout.rpc).not.toHaveBeenCalledWith('pay_waffo_close_card_checkout', expect.objectContaining({ p_rejected: true }));
  });
});

describe('expired card checkout release', () => {
  it('asks the database to close only this merchant\'s open unpaid card orders and tolerates early denials', async () => {
    const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) => (call[1].p_order === 'early'
      ? { data: null, error: { message: 'PAY_WAFFO_CLOSE_DENIED' } } : { data: null, error: null }));
    const base = { payment_channel: 'waffo', payment_method: 'card', payment_mode: 'test', merchant_namespace: 'fixture',
      qualification_state: 'reserved', payment_status: 'unpaid', purchase_closed_at: null, user_id: user };
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const db = fakeDb({ payment_orders: [{ ...base, id: 'recent', created_at: ago(5) }, { ...base, id: 'early', created_at: ago(45) },
      { ...base, id: 'old', created_at: ago(90) }, { ...base, id: 'wallet', payment_method: 'alipay', created_at: ago(90) },
      { ...base, id: 'closed', purchase_closed_at: '2026-10-11T00:00:00Z', created_at: ago(90) }] }, rpc);
    expect(await closeExpiredWaffoCheckouts(db, 'fixture')).toBe(1);
    // Recent rows never take a slot in the capped batch; oldest first.
    expect(rpc.mock.calls.map(c => c[1].p_order)).toEqual(['old', 'early']);
    rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    await expect(closeExpiredWaffoCheckouts(db, 'fixture')).rejects.toThrow('PERSISTENCE_UNAVAILABLE');
  });
});
