/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverWaffoOneTimeCheckouts } from './waffoOneTimeRecovery';
import { closeExpiredWaffoCheckouts } from './waffoCardCheckout';
import { fakeDb, payment } from './waffoTestHarness';
const orderId = '00000000-0000-4000-8000-000000000001';
function setup() {
  const rpc = vi.fn(async (fn: string) => ({ data: fn === 'pay_failover_fulfill' ? { state: 'fulfilled' } : 'released', error: null }));
  const db = fakeDb({ payment_orders: [{ id: orderId, user_id: 'buyer', payment_channel: 'waffo', mode: 'payment', auto_renew: false,
    payment_method: 'card', payment_mode: 'test', merchant_namespace: 'fixture', qualification_state: 'reserved', payment_status: 'unpaid',
    purchase_closed_at: null, method_checkout_expires_at: '2026-10-01T00:30:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    checkout_request: { purchaseMode: 'payment' }, price_ref_id: 'price-1', item_type: 'credit_package' }],
    payment_provider_refs: [{ order_id: orderId, object_type: 'checkout', channel: 'waffo', mode: 'test', merchant_namespace: 'fixture', external_id: 'cs_original' },
    { id: 'price-1', object_type: 'price', channel: 'waffo', mode: 'test', merchant_namespace: 'fixture', external_id: 'PROD_once' }],
  }, rpc);
  const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
    findOneTimeOrders: vi.fn().mockResolvedValue([{ id: 'ORD_fixture1', status: 'canceled', storeId: 'STO_fixture', testMode: true, orderMerchantExternalId: orderId }]),
    findOrderPayments: vi.fn().mockResolvedValue([]), readChargebacks: vi.fn().mockResolvedValue([]) };
  return { db, rpc, provider };
}
afterEach(() => vi.useRealTimers());
describe('one-time recovery never treats local timeout as no charge', () => {
  it('skips every one-time order in legacy TTL close', async () => {
    const f = setup(); expect(await closeExpiredWaffoCheckouts(f.db, 'fixture')).toBe(0);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('releases only after a complete provider terminal-unpaid read of the original order', async () => {
    const f = setup(); expect(await recoverWaffoOneTimeCheckouts(f.db, f.provider)).toEqual({ closed: 1, blocked: [] });
    expect(f.provider.findOrderPayments).toHaveBeenCalledWith(orderId, expect.any(Number));
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.objectContaining({
      p_order: orderId, p_checkout: 'cs_original', p_state: 'closed_unpaid', p_payment: null, p_amount: 0 }));
  });
  it.each(['missing', 'pending', 'unknown', 'lookup_failure'])('keeps %s results blocked without closing or reopening a channel', async kind => {
    const f = setup();
    if (kind === 'missing') f.provider.findOneTimeOrders.mockResolvedValueOnce([]);
    else if (kind === 'lookup_failure') f.provider.findOrderPayments.mockRejectedValueOnce(new Error('incomplete'));
    else f.provider.findOrderPayments.mockResolvedValueOnce([payment({ status: kind })]);
    expect(await recoverWaffoOneTimeCheckouts(f.db, f.provider)).toEqual({ closed: 0, blocked: [orderId] });
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.anything());
  });
  it('recovers already paid cash before a second-channel purchase and does not report it as unresolved', async () => {
    const f = setup(); f.provider.findOrderPayments.mockResolvedValueOnce([payment({ periodNumber: null, subscriptionOrder: null,
      onetimeOrder: { id: 'ORD_fixture1', storeId: 'STO_fixture', status: 'completed', testMode: true,
        orderMerchantExternalId: orderId, onetimeProduct: { id: 'PROD_once' } } })]);
    expect(await recoverWaffoOneTimeCheckouts(f.db, f.provider)).toEqual({ closed: 0, blocked: [] });
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_payment: 'PAY_fixture1' }));
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_observe_qualification', expect.anything());
  });
  it('honors a shared cron deadline and leaves unknown orders reserved', async () => {
    const f = setup(); const deadline = Date.now() - 1;
    expect(await recoverWaffoOneTimeCheckouts(f.db, f.provider, undefined, undefined, deadline)).toEqual({ closed: 0, blocked: [orderId] });
    expect(f.provider.findOneTimeOrders).not.toHaveBeenCalled();
  });
});
