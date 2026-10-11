/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, it, expect, vi } from 'vitest';
import { buildWaffoCheckoutRequest, dispatchWaffoCheckout, validateWaffoCheckoutSession } from './waffoCheckout';
const snapshot = { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000001',
  item_updated_at: '2026-10-01T00:00:00.000Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
  price: '49.00', discount: '0.00', tax_behavior: 'inclusive', credits: 8970, bonus_credits: 0 };
const input = { order: { id: '00000000-0000-4000-8000-000000000002', user_id: '00000000-0000-4000-8000-000000000003',
  merchant_namespace: 'fixture', payment_mode: 'test' as const, payment_channel: 'waffo', payment_method: 'card', offer_kind: 'gold_first30', purchase_snapshot: snapshot },
  productId: 'PROD_test', merchantNamespace: 'fixture', appUrl: 'https://app.example.invalid' };
const now = Date.parse('2026-10-11T00:00:00Z');
const validation = { createdAfter: now, latestExpiry: now + 1800000, allowedCheckoutOrigin: 'https://checkout.waffo.ai' };
const session = { sessionId: 'cs_00000000-0000-4000-8000-000000000004',
  checkoutUrl: 'https://checkout.waffo.ai/store/checkout/cs_00000000-0000-4000-8000-000000000004',
  expiresAt: new Date(now + 1800000).toISOString() };
describe('Waffo checkout intent', () => {
  it('explicitly controls first 30 days, card, opaque identity and internal order', () => {
    const request = buildWaffoCheckoutRequest(input);
    expect(request.withTrial).toBe(true); expect(request.includePaymentMethods).toEqual(['card']);
    expect(request.buyerIdentity).toMatch(/^[a-f0-9]{64}$/); expect(request.buyerIdentity).not.toContain(input.order.user_id);
    expect(request.orderMerchantExternalId).toBe(input.order.id);
    expect(buildWaffoCheckoutRequest({ ...input, order: { ...input.order, offer_kind: 'standard' } }).withTrial).toBe(false);
  });
  it('blocks live and changed founder prices', () => {
    expect(() => buildWaffoCheckoutRequest({ ...input, order: { ...input.order, payment_mode: 'live' } })).toThrow();
    expect(() => buildWaffoCheckoutRequest({ ...input, order: { ...input.order, offer_kind: 'founder' } })).toThrow();
  });
  it('rejects a checkout client from a different merchant before constructing a request', () => {
    expect(() => buildWaffoCheckoutRequest({ ...input, merchantNamespace: 'other-account' })).toThrow('PAY_WAFFO_CHECKOUT_INVALID');
  });
  it('rejects unbounded expiry and external redirect', () => {
    expect(validateWaffoCheckoutSession(session, validation)).toEqual(session);
    expect(() => validateWaffoCheckoutSession({ ...session, expiresAt: new Date(now + 1800001).toISOString() }, validation)).toThrow();
    expect(() => validateWaffoCheckoutSession({ ...session, checkoutUrl: session.checkoutUrl.replace('checkout.waffo.ai', 'evil.invalid') }, validation)).toThrow();
  });
  it('does not re-dispatch after timeout or failed persistence', async () => {
    let claimed = false;
    const create = vi.fn().mockRejectedValue(new Error('timeout'));
    const recover = vi.fn().mockResolvedValue(null);
    const args = { ...validation, request: buildWaffoCheckoutRequest(input), create, recover, persist: vi.fn(),
      claimDispatch: async () => { if (claimed) return false; claimed = true; return true; } };
    await expect(dispatchWaffoCheckout(args)).rejects.toThrow('timeout');
    await expect(dispatchWaffoCheckout(args)).rejects.toThrow('PAY_WAFFO_RECONCILIATION_REQUIRED');
    expect(create).toHaveBeenCalledTimes(1);
    recover.mockResolvedValue(session); args.persist.mockRejectedValueOnce(new Error('write failed'));
    await expect(dispatchWaffoCheckout(args)).rejects.toThrow('write failed');
    await dispatchWaffoCheckout(args); expect(create).toHaveBeenCalledTimes(1);
  });
});
