/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { processWaffoReceipt } from './waffoPaymentDelivery';
import { readPaymentFacts, type WaffoPayment } from './waffoPayments';
import { fakeDb, payment } from './waffoTestHarness';

const orderId = '00000000-0000-4000-8000-000000000001';
const receipt = { id: 'receipt-1', merchant: 'fixture', refs: { paymentId: 'PAY_fixture1', orderId: 'ORD_fixture1' } };
function setup(found: WaffoPayment | null, rpcResult: unknown = { data: { state: 'fulfilled' }, error: null }, extra = {}) {
  const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) => (call[0] === 'pay_waffo_resolve_receipt'
    ? { data: null, error: null } : rpcResult));
  const db = fakeDb({
    waffo_event_receipts: [{ id: 'receipt-1', merchant_namespace: 'fixture', mode: 'test', status: 'received' }],
    payment_orders: [{ id: orderId, payment_channel: 'waffo', payment_method: 'card', merchant_namespace: 'fixture', payment_mode: 'test' }],
    payment_provider_refs: [
      { order_id: orderId, object_type: 'checkout', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test', external_id: 'cs_1' },
      { subscription_id: 'sub-1', object_type: 'subscription', channel: 'waffo', merchant_namespace: 'fixture', mode: 'test',
        external_id: 'ORD_renewing' }],
    ...extra,
  }, rpc);
  const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
    readPayment: vi.fn().mockResolvedValue(found), listPayments: vi.fn() };
  return { db, rpc, provider, run: () => processWaffoReceipt(db, provider, receipt) };
}
const resolved = (rpc: ReturnType<typeof setup>['rpc']) => rpc.mock.calls.find(([fn]) => fn === 'pay_waffo_resolve_receipt')?.[1];

describe('Waffo payment facts (normal path only)', () => {
  it('accepts the measured shape and keeps unknown cases out of automation', () => {
    expect(readPaymentFacts(payment(), 'STO_fixture')).toMatchObject({ kind: 'paid', facts: { amountCents: 6900, periodNumber: 1 } });
    expect(readPaymentFacts(payment({ status: 'pending' }), 'STO_fixture').kind).toBe('not_paid');
    const reason = (p: WaffoPayment) => { const r = readPaymentFacts(p, 'STO_fixture'); return r.kind === 'unknown' ? r.reason : r.kind; };
    expect(reason(payment({ periodNumber: 2 }))).toBe('period_not_current');
    expect(reason(payment({}, { currentPeriodStart: null }))).toBe('period_not_current');
    expect(reason(payment({ pspAmountDetails: { amount: '49.00', currency: 'USD' } }))).toBe('amount_unproven');
    expect(reason(payment({ pspAmountDetails: null }))).toBe('amount_unproven');
    expect(reason(payment({ refundStatus: 'pending' }))).toBe('refund_observed');
    expect(reason(payment({}, { storeId: 'STO_other' }))).toBe('store_scope');
    expect(reason(payment({ testMode: false }))).toBe('test_mode_unproven');
    expect(reason(payment({ paymentMethod: { type: 'wallet' } }))).toBe('method_not_card');
  });
});

describe('Waffo receipt delivery', () => {
  it('delivers a first payment through the original order, checkout and Waffo period', async () => {
    const f = setup(payment());
    expect(await f.run()).toEqual({ state: 'applied', reason: 'delivered' });
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_fulfill_payment', { p_order: orderId, p_merchant: 'fixture', p_checkout: 'cs_1',
      p_payment: 'PAY_fixture1', p_amount: 6900, p_currency: 'usd', p_paid_at: '2026-10-11T05:59:48.325Z',
      p_subscription: 'ORD_fixture1', p_start: '2026-10-11T05:59:47.000Z', p_end: '2026-11-11T05:59:47.000Z' });
  });
  it('still delivers when the callback arrives hours later: timing uses Waffo record time, not arrival', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T09:00:00Z'));
    try {
      const f = setup(payment());
      expect((await f.run()).state).toBe('applied');
      expect(f.rpc.mock.calls[0]?.[1]).toMatchObject({ p_paid_at: '2026-10-11T05:59:48.325Z' });
    } finally { vi.useRealTimers(); }
  });
  it('renews through the mapped subscription; the database checks the recorded order price', async () => {
    const f = setup(payment({ orderId: 'ORD_renewing', periodNumber: 2 },
      { id: 'ORD_renewing', currentPeriodNumber: 2, currentPeriodStart: '2026-11-11T05:59:47.000Z', currentPeriodEnd: '2026-12-11T05:59:47.000Z' }));
    expect((await f.run()).state).toBe('applied');
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_renew_subscription', expect.objectContaining({ p_subscription: 'sub-1',
      p_amount: 6900, p_start: '2026-11-11T05:59:47.000Z', p_end: '2026-12-11T05:59:47.000Z' }));
  });
  it('turns database rejections (e.g. outside the time tolerance) into review, never a grant', async () => {
    const f = setup(payment(), { data: null, error: { message: 'PAY_WAFFO_TERM_INVALID' } });
    expect(await f.run()).toEqual({ state: 'review', reason: 'pay_waffo_term_invalid' });
    const review = setup(payment(), { data: { state: 'review', reason: 'refund_observed' }, error: null });
    expect(await review.run()).toEqual({ state: 'review', reason: 'refund_observed' });
  });
  it('records an unknown payment as offsite (refund due, no grant)', async () => {
    const f = setup(payment({ orderMerchantExternalId: 'someone-else' }), { data: { alert: false }, error: null });
    expect(await f.run()).toEqual({ state: 'review', reason: 'offsite' });
    expect(f.rpc).toHaveBeenCalledWith('pay_waffo_record_offsite', expect.objectContaining({ p_cash: expect.objectContaining({
      paymentId: 'PAY_fixture1', productId: 'PROD_fixture', amount: '6900', currency: 'usd' }) }));
    expect(f.rpc).not.toHaveBeenCalledWith('pay_waffo_fulfill_payment', expect.anything());
  });
  it('leaves unknown facts for reconciliation and does not infer a period', async () => {
    const f = setup(payment({ periodNumber: 3 }));
    expect(await f.run()).toEqual({ state: 'review', reason: 'period_not_current' });
    expect(resolved(f.rpc)).toMatchObject({ p_state: 'review', p_reason: 'period_not_current' });
  });
  it('asks for redelivery on transient failures, and skips receipts already resolved', async () => {
    await expect(setup(null).run()).rejects.toThrow('NOT_VISIBLE');
    await expect(setup(payment(), { data: null, error: { message: 'connection reset' } }).run()).rejects.toThrow('DELIVERY_UNAVAILABLE');
    const done = setup(payment(), undefined, { waffo_event_receipts: [{ id: 'receipt-1', merchant_namespace: 'fixture', mode: 'test', status: 'applied' }] });
    expect(await done.run()).toEqual({ state: 'ignored', reason: 'already_resolved' });
    expect(done.provider.readPayment).not.toHaveBeenCalled();
    expect(await setup(payment({ status: 'failed' })).run()).toEqual({ state: 'ignored', reason: 'not_paid' });
  });
});
