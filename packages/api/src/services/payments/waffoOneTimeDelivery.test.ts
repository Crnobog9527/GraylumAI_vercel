/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { describe, expect, it, vi } from 'vitest';
import { processWaffoReceipt } from './waffoPaymentDelivery';
import { reconcileWaffoPayments } from './waffoReconciliation';
import { fakeDb, payment } from './waffoTestHarness';
const orderId = '00000000-0000-4000-8000-000000000001';
const receipt = { id: 'receipt-1', merchant: 'fixture', refs: { paymentId: 'PAY_fixture1' } };
function setup(method = 'card', fields = {}) {
  const found = payment({ periodNumber: null, subscriptionOrder: null, paymentMethod: { type: method }, onetimeOrder: {
    id: 'ORD_fixture1', storeId: 'STO_fixture', status: 'completed', testMode: true, orderMerchantExternalId: orderId,
    onetimeProduct: { id: 'PROD_onetime' } } });
  const rpc = vi.fn(async (fn: string) => ({ data: fn === 'pay_failover_fulfill'
    ? { state: method === 'unknown' ? 'review' : 'fulfilled' } : null, error: null }));
  const db = fakeDb({
    waffo_event_receipts: [{ id: 'receipt-1', merchant_namespace: 'fixture', mode: 'test', status: 'received' }],
    payment_orders: [{ id: orderId, user_id: 'buyer', payment_channel: 'waffo', payment_method: 'card', auto_renew: false,
      merchant_namespace: 'fixture', payment_mode: 'test', item_type: 'membership_plan', entitlement_term: 'month', price_ref_id: 'price-1', ...fields },
    { id: 'source', user_id: 'buyer', entitlement_end: '2026-12-11T05:59:48.325Z' }],
    payment_provider_refs: [
      { order_id: orderId, object_type: 'checkout', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test', external_id: 'cs_1' },
      { id: 'price-1', object_type: 'price', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test', external_id: 'PROD_onetime' }],
  }, rpc);
  const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
    readPayment: vi.fn().mockResolvedValue(found), listPayments: vi.fn().mockResolvedValue({ rows: [found], complete: true }),
    readChargebacks: vi.fn().mockResolvedValue([]), cancelSubscription: vi.fn(), readSubscription: vi.fn() };
  return { db, rpc, provider };
}
describe('Waffo one-time delivery and backstop', () => {
  it('delivers card/Alipay from the original checkout without external subscription operations', async () => {
    const f = setup('alipay');
    expect(await processWaffoReceipt(f.db, f.provider, receipt)).toEqual({ state: 'applied', reason: 'delivered' });
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', { p_order: orderId, p_merchant: 'fixture', p_checkout: 'cs_1',
      p_payment: 'PAY_fixture1', p_method: 'alipay', p_amount: 6900, p_currency: 'usd', p_paid_at: '2026-10-11T05:59:48.325Z',
      p_review: null, p_start: '2026-10-11T05:59:48.325Z', p_end: '2026-11-11T05:59:48.325Z' });
    expect(f.provider.cancelSubscription).not.toHaveBeenCalled();
    expect(f.provider.readSubscription).not.toHaveBeenCalled();
  });
  it('records proven cash with unknown method for review and sends no invented entitlement term', async () => {
    const f = setup('unknown');
    expect((await processWaffoReceipt(f.db, f.provider, receipt)).state).toBe('review');
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_method: 'unknown', p_amount: 6900, p_start: null, p_end: null }));
  });
  it('uses the original expiry for same-level renewal and sends packs with no membership term', async () => {
    const f = setup('card', { method_transition: 'wallet_renewal', source_order_id: 'source', entitlement_term: 'year' });
    await processWaffoReceipt(f.db, f.provider, receipt);
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_start: '2026-12-11T05:59:48.325Z', p_end: '2027-12-11T05:59:48.325Z' }));
    const pack = setup('card', { item_type: 'credit_package' });
    await processWaffoReceipt(pack.db, pack.provider, receipt);
    expect(pack.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_start: null, p_end: null }));
  });
  it('keeps the receipt retryable until the post-delivery upgrade stop is confirmed', async () => {
    const f = setup(), after = vi.fn().mockRejectedValueOnce(new Error('prior_stop_pending')).mockResolvedValueOnce(undefined);
    await expect(processWaffoReceipt(f.db, f.provider, receipt, after)).rejects.toThrow('prior_stop_pending');
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_resolve_receipt', expect.anything());
    expect((await processWaffoReceipt(f.db, f.provider, receipt, after)).state).toBe('applied');
    expect(after).toHaveBeenCalledWith(orderId);
  });
  it('recovers a lost one-time callback from a fresh provider read even after the sales channel changed', async () => {
    const f = setup();
    await reconcileWaffoPayments(f.db, f.provider, { recover: true });
    expect(f.provider.readPayment).toHaveBeenCalledWith('PAY_fixture1');
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_payment: 'PAY_fixture1' }));
  });
  it('records the actual method and freezes the original source using the real dispute identity', async () => {
    const f = setup(); f.provider.readChargebacks.mockResolvedValue([{ id: 'CBK_real', paymentId: 'PAY_fixture1', storeId: 'STO_fixture',
      orderId: 'ORD_fixture1', status: 'open', testMode: true, amount: { amount: '100', currency: 'USD' }, createdAt: '2026-10-20T00:00:00.000Z' }]);
    expect(await processWaffoReceipt(f.db, f.provider, receipt)).toEqual({ state: 'review', reason: 'chargeback_observed' });
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_fulfill', expect.objectContaining({ p_method: 'card', p_review: 'chargeback_observed' }));
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_dispute_observed', { p_order: orderId, p_merchant: 'fixture', p_mode: 'test',
      p_payment: 'PAY_fixture1', p_dispute: 'CBK_real', p_amount: 100, p_currency: 'usd', p_observed_at: '2026-10-20T00:00:00.000Z' });
    await reconcileWaffoPayments(f.db, f.provider, { recover: true });
    expect(f.rpc.mock.calls.filter(([fn]) => fn === 'pay_failover_dispute_observed')).toHaveLength(2);
  });
  it('freezes a strongly identified dispute even when its loss amount or currency is unknown', async () => {
    const f = setup(); f.provider.readChargebacks.mockResolvedValue([{ id: 'CBK_unknown', paymentId: 'PAY_fixture1', storeId: 'STO_fixture',
      orderId: 'ORD_fixture1', status: 'open', testMode: true, amount: null, createdAt: '2026-10-20T00:00:00.000Z' }]);
    expect(await processWaffoReceipt(f.db, f.provider, receipt)).toEqual({ state: 'review', reason: 'chargeback_amount_unknown' });
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_dispute_observed', expect.objectContaining({
      p_dispute: 'CBK_unknown', p_amount: null, p_currency: null }));
  });
  it('reports a shared deadline as incomplete without issuing more provider reads', async () => {
    const f = setup();
    const result = await reconcileWaffoPayments(f.db, f.provider, { recover: true, deadline: Date.now() - 1 });
    expect(result).toMatchObject({ success: false, complete: false, findings: [{ kind: 'scan_incomplete' }] });
    expect(f.provider.listPayments).not.toHaveBeenCalled();
    expect(f.provider.readPayment).not.toHaveBeenCalled();
  });
  it('late/repeated cash relies on the atomic original-order result and never cancels a one-time order', async () => {
    const f = setup(); f.rpc.mockImplementation(async fn => ({ data: fn === 'pay_failover_fulfill' ? { state: 'review' } : null, error: null }));
    expect((await processWaffoReceipt(f.db, f.provider, receipt)).state).toBe('review');
    expect(f.provider.cancelSubscription).not.toHaveBeenCalled();
    const failed = setup(); failed.provider.readPayment.mockResolvedValueOnce(payment({ status: 'failed', subscriptionOrder: null }));
    expect((await processWaffoReceipt(failed.db, failed.provider, receipt)).state).toBe('ignored');
    expect(failed.rpc).not.toHaveBeenCalledWith('pay_failover_fulfill', expect.anything());
  });
});
