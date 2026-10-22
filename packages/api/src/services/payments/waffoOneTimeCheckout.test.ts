/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./methodPurchase', async original => ({ ...await original<typeof import('./methodPurchase')>(), prepareMethodPurchase: mocks.prepare }));
import { createWaffoOneTimeCheckout } from './waffoOneTimeCheckout';
import { fakeDb } from './waffoTestHarness';
const id = '00000000-0000-4000-8000-000000000001', user = '00000000-0000-4000-8000-000000000002';
const sessionId = 'cs_73f87372-a33f-096f-e2e2-c8254e0062d1';
const order = { id, user_id: user, payment_mode: 'test', payment_channel: 'waffo', merchant_namespace: 'fixture', payment_method: 'card',
  offer_kind: 'standard', amount_total: 6900, price_ref_id: 'ref-1', purchase_snapshot: { version: 1, item_type: 'membership_plan', item_id: id,
    item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
    price: '69.00', discount: '0.00', tax_behavior: 'inclusive', credits: 8970, bonus_credits: 0 } };
function setup() {
  let claimed = false;
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'pay_waffo_claim_checkout') return { data: null, error: null };
    const dispatch = !claimed; claimed = true;
    return { data: { dispatch, request: args.p_request, expiresAt: args.p_expires }, error: null };
  });
  const db = fakeDb({ payment_provider_refs: [{ id: 'ref-1', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test',
    object_type: 'price', external_id: 'PROD_onetime' }] }, rpc);
  const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
    findOneTimeOrders: vi.fn(), findOrderPayments: vi.fn(), readChargebacks: vi.fn().mockResolvedValue([]),
    readOneTimeProduct: vi.fn().mockResolvedValue({ id: 'PROD_onetime', storeId: 'STO_fixture', status: 'active',
      prices: [{ currency: 'USD', priceInfo: { amount: '69.00', taxCategory: 'saas' } }] }),
    createCheckout: vi.fn().mockResolvedValue({ sessionId, checkoutUrl: `https://pancake.waffo.ai/store/fixture/checkout/${sessionId}?test=true`,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString() }) };
  const run = () => createWaffoOneTimeCheckout({ db, provider, userId: user, appUrl: 'https://app.test.invalid', termsVersion: 'terms-1',
    checkoutOrigin: 'https://pancake.waffo.ai', purchase: { itemType: 'membership_plan', itemId: id, billingCycle: 'monthly',
      method: 'card', offer: 'standard', acceptedTerms: true, routingVersion: 2 } });
  return { rpc, provider, run };
}
describe('Waffo one-time checkout dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.prepare.mockResolvedValue(order); });
  it('creates one non-recurring checkout across concurrent submissions, persisting the exact wrapper', async () => {
    const f = setup();
    const results = await Promise.all([f.run(), f.run()]);
    expect(results.map(r => r.state).sort()).toEqual(['open', 'recovery_required']);
    expect(f.provider.createCheckout).toHaveBeenCalledTimes(1);
    expect(f.provider.createCheckout.mock.calls[0]![0]).toMatchObject({ withTrial: false, productId: 'PROD_onetime',
      priceSnapshot: { amount: '69.00', taxIncluded: true, taxCategory: 'saas' } });
    expect(f.provider.createCheckout.mock.calls[0]![0]).not.toHaveProperty('includePaymentMethods');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_claim_checkout', expect.objectContaining({ p_request: expect.objectContaining({
      purchaseMode: 'payment', mode: 'test', method: 'card', orderId: id, userId: user }) }));
  });
  it('never creates again after an unknown provider outcome or a failed bind', async () => {
    const unknown = setup(); unknown.provider.createCheckout.mockRejectedValueOnce(new Error('PAY_WAFFO_PROVIDER_UNAVAILABLE'));
    await expect(unknown.run()).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect((await unknown.run()).state).toBe('recovery_required');
    expect(unknown.provider.createCheckout).toHaveBeenCalledTimes(1);
    expect(unknown.rpc).not.toHaveBeenCalledWith('pay_waffo_close_card_checkout', expect.anything());
    const failedBind = setup();
    failedBind.rpc.mockImplementationOnce(async () => ({ data: { dispatch: true, request: { providerRequest: {} }, expiresAt: undefined }, error: null }));
    failedBind.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'connection reset' } }) as never);
    await expect(failedBind.run()).rejects.toThrow('CHECKOUT_UNAVAILABLE');
  });
  it('rejects an inactive or cross-store one-time product before a checkout dispatch', async () => {
    const f = setup(); f.provider.readOneTimeProduct.mockResolvedValueOnce({ id: 'PROD_onetime', storeId: 'STO_other', status: 'active', prices: [] });
    await expect(f.run()).rejects.toThrow('PRICE_UNAVAILABLE');
    expect(f.provider.createCheckout).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_claim_checkout', expect.anything());
  });
  it.each([
    [{ currency: 'USD', priceInfo: { amount: '99.00', taxCategory: 'saas' } }],
    [{ currency: 'EUR', priceInfo: { amount: '69.00', taxCategory: 'saas' } }],
    [{ currency: 'USD', priceInfo: { amount: '69.00', taxCategory: 'unknown' } }],
    [],
  ])('fails closed and releases before dispatch when product price facts disagree: %j', async (...prices) => {
    const f = setup(); f.provider.readOneTimeProduct.mockResolvedValueOnce({ id: 'PROD_onetime', storeId: 'STO_fixture', status: 'active', prices });
    await expect(f.run()).rejects.toThrow('PRICE_UNAVAILABLE');
    expect(f.provider.createCheckout).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_abort_before_dispatch', expect.objectContaining({ p_order: id }));
  });
  it('locks the admitted discounted amount inclusive of tax, without a trial or a later product-price dependency', async () => {
    mocks.prepare.mockResolvedValueOnce({ ...order, amount_total: 5900, purchase_snapshot: { ...order.purchase_snapshot, discount: '10.00' } });
    const f = setup(); await f.run();
    expect(f.provider.createCheckout.mock.calls[0]![0]).toMatchObject({ withTrial: false,
      priceSnapshot: { amount: '59.00', taxIncluded: true, taxCategory: 'saas' } });
  });
  it('accepts a Pro credit package mapped at its admitted member price', async () => {
    mocks.prepare.mockResolvedValueOnce({ ...order, amount_total: 940, purchase_snapshot: { ...order.purchase_snapshot,
      item_type: 'credit_package', billing_cycle: 'one_time', price: '9.40', credits: 990 } });
    const f = setup(); f.provider.readOneTimeProduct.mockResolvedValueOnce({ id: 'PROD_onetime', storeId: 'STO_fixture', status: 'active',
      prices: [{ currency: 'USD', priceInfo: { amount: '9.40', taxCategory: 'saas' } }] });
    await f.run();
    expect(f.provider.createCheckout.mock.calls[0]![0]).toMatchObject({ priceSnapshot: { amount: '9.40', taxIncluded: true } });
  });
  it('releases only a definitively rejected provider create, leaving ambiguous failures blocked', async () => {
    const f = setup(); f.provider.createCheckout.mockRejectedValueOnce(new Error('PAY_WAFFO_PROVIDER_REJECTED'));
    await expect(f.run()).rejects.toThrow('PROVIDER_REJECTED');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_close_card_checkout', { p_user: user, p_order: id, p_merchant: 'fixture', p_rejected: true });
  });
});
