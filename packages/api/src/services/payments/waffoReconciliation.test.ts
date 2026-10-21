/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { reconcileWaffoPayments } from './waffoReconciliation';
import { fakeDb, payment } from './waffoTestHarness';

const ref = (external_id: string, order_id: string) => ({ external_id, order_id, channel: 'waffo', merchant_namespace: 'fixture',
  mode: 'test', object_type: 'payment' });
describe('Waffo daily reconciliation (report only)', () => {
  it('lists paid-but-undelivered, refund candidates and delivered-without-payment; grants nothing', async () => {
    const rows = [payment({ id: 'PAY_ok' }), payment({ id: 'PAY_missing' }), payment({ id: 'PAY_renewal_after_cancel' }),
      payment({ id: 'PAY_offsite' }, { status: 'canceling' }), payment({ id: 'PAY_refunded', refundStatus: 'succeeded', refundedAmount: { amount: '6900', currency: 'USD' } }),
      payment({ id: 'PAY_failed', status: 'failed' }), payment({ id: 'PAY_unseen_offsite', orderMerchantExternalId: 'not-a-site-order' }),
      payment({ id: 'PAY_dashes', orderMerchantExternalId: '-'.repeat(36) }, { status: 'pending' }),
      payment({ id: 'PAY_stripe_order', orderMerchantExternalId: '00000000-0000-4000-8000-000000000009' }),
      payment({ id: 'PAY_after_timeout', orderMerchantExternalId: '00000000-0000-4000-8000-00000000000a' }),
      payment({ id: 'PAY_second_for_order', orderMerchantExternalId: '00000000-0000-4000-8000-00000000000b' }, { status: 'canceling' }),
      payment({ id: 'PAY_renewal_lost_webhook', orderMerchantExternalId: '00000000-0000-4000-8000-00000000000b', periodNumber: 2 })];
    const rpc = vi.fn();
    const db = fakeDb({
      payment_provider_refs: [ref('PAY_ok', 'o-ok'), ref('PAY_renewal_after_cancel', 'o-review'), ref('PAY_refunded', 'o-refunded'),
        ref('PAY_ghost', 'o-ghost')],
      payment_orders: [{ id: 'o-ok', fulfilled_at: '2026-10-11T06:00:00Z' },
        { id: 'o-review', fulfilled_at: null, qualification_state: 'review', method_review_reason: 'unexpected_renewal' },
        { id: 'o-refunded', fulfilled_at: '2026-10-11T06:00:00Z' }, { id: 'o-ghost', fulfilled_at: '2026-10-11T06:00:00Z' },
        { id: '00000000-0000-4000-8000-000000000001', fulfilled_at: null, payment_channel: 'waffo', payment_method: 'card',
          merchant_namespace: 'fixture', payment_mode: 'test' },
        { id: '00000000-0000-4000-8000-000000000009', fulfilled_at: null, payment_channel: 'stripe', payment_method: 'alipay',
          merchant_namespace: 'fixture', payment_mode: 'test' },
        { id: '00000000-0000-4000-8000-00000000000a', fulfilled_at: null, payment_channel: 'waffo', payment_method: 'card',
          merchant_namespace: 'fixture', payment_mode: 'test', qualification_state: 'released', method_review_reason: 'card_checkout_expired' },
        { id: '00000000-0000-4000-8000-00000000000b', fulfilled_at: '2026-10-11T06:00:00Z', payment_channel: 'waffo', payment_method: 'card',
          merchant_namespace: 'fixture', payment_mode: 'test', qualification_state: 'sold' }],
      waffo_event_receipts: [{ merchant_namespace: 'fixture', mode: 'test', resolution: { kind: 'offsite', cash: { paymentId: 'PAY_offsite' } } },
        { id: 'rcpt-stale', event_type: 'subscription.payment_succeeded', merchant_namespace: 'fixture', mode: 'test', status: 'received',
          received_at: '2026-01-01T00:00:00Z' },
        { id: 'rcpt-lifecycle', event_type: 'subscription.past_due', merchant_namespace: 'fixture', mode: 'test', status: 'received',
          received_at: '2026-01-01T00:00:00Z' },
        { id: 'rcpt-fresh', event_type: 'subscription.payment_succeeded', merchant_namespace: 'fixture', mode: 'test', status: 'received',
          received_at: '2999-01-01T00:00:00Z' }],
    }, rpc);
    const listPayments = vi.fn().mockResolvedValue({ rows, complete: true });
    const result = await reconcileWaffoPayments(db, { merchant: 'fixture', mode: 'test', listPayments });
    expect(result.success).toBe(false);
    expect(result.findings).toEqual([
      { kind: 'paid_not_delivered', paymentId: 'PAY_missing', refundCandidate: false, renewalActive: true },
      { kind: 'paid_in_review', paymentId: 'PAY_renewal_after_cancel', orderId: 'o-review', reason: 'unexpected_renewal', refundCandidate: true,
        renewalActive: true },
      { kind: 'offsite_refund_due', paymentId: 'PAY_offsite', refundCandidate: true },
      { kind: 'refund_observed', paymentId: 'PAY_refunded', orderId: 'o-refunded', refundCandidate: false },
      { kind: 'offsite_refund_due', paymentId: 'PAY_unseen_offsite', refundCandidate: true, renewalActive: true },
      { kind: 'offsite_refund_due', paymentId: 'PAY_dashes', refundCandidate: true, renewalActive: true },
      { kind: 'offsite_refund_due', paymentId: 'PAY_stripe_order', refundCandidate: true, renewalActive: true },
      { kind: 'paid_in_review', paymentId: 'PAY_after_timeout', orderId: '00000000-0000-4000-8000-00000000000a',
        reason: 'card_checkout_expired', refundCandidate: true, renewalActive: true },
      { kind: 'paid_in_review', paymentId: 'PAY_second_for_order', orderId: '00000000-0000-4000-8000-00000000000b',
        reason: 'duplicate_order_payment', refundCandidate: true },
      // A renewal whose webhook was lost is undelivered cash, never a refund candidate.
      { kind: 'paid_not_delivered', paymentId: 'PAY_renewal_lost_webhook', refundCandidate: false, renewalActive: true },
      { kind: 'receipt_unprocessed', receiptId: 'rcpt-stale', refundCandidate: false },
      { kind: 'delivered_without_payment', paymentId: 'PAY_ghost', orderId: 'o-ghost', refundCandidate: false },
    ]);
    // Already stopped (PAY_offsite is canceling) is not flagged; a non-candidate is never flagged.
    expect(rpc).not.toHaveBeenCalled();
  });
  it('reports an incomplete scan and skips the reverse check instead of guessing', async () => {
    const db = fakeDb({ payment_provider_refs: [ref('PAY_ghost', 'o-ghost')], payment_orders: [{ id: 'o-ghost', fulfilled_at: 'x' }] }, vi.fn());
    const listPayments = vi.fn().mockResolvedValue({ rows: [], complete: false });
    const result = await reconcileWaffoPayments(db, { merchant: 'fixture', mode: 'test', listPayments });
    expect(listPayments).toHaveBeenCalledTimes(20);
    expect(result.findings).toEqual([{ kind: 'scan_incomplete', refundCandidate: false }]);
  });
  it('is clean when every paid Waffo payment was delivered', async () => {
    const db = fakeDb({ payment_provider_refs: [ref('PAY_ok', 'o-ok')], payment_orders: [{ id: 'o-ok', fulfilled_at: 'x' }] }, vi.fn());
    const listPayments = vi.fn().mockResolvedValue({ rows: [payment({ id: 'PAY_ok' })], complete: true });
    expect(await reconcileWaffoPayments(db, { merchant: 'fixture', mode: 'test', listPayments }))
      .toEqual({ success: true, checkedPayments: 1, complete: true, findings: [] });
  });
});

const refundOrderId = '00000000-0000-4000-8000-000000000051';
const approvalId = '00000000-0000-4000-8000-000000000052';
function settledRefundFixture(full = false) {
  const netMinor = full ? 6900 : 6000;
  const order = { id: refundOrderId, payment_channel: 'waffo', merchant_namespace: 'fixture', payment_mode: 'test',
    amount_total: 6900, currency: 'usd', fulfilled_at: '2026-10-11T06:00:00Z', qualification_state: 'sold',
    status: full ? 'refunded' : 'partially_refunded', payment_status: full ? 'refunded' : 'partially_refunded',
    refund_approval: { id: approvalId, orderId: refundOrderId, status: 'succeeded', currency: 'usd', netMinor,
      refundId: 'REF_settled', idempotencyKey: `pay-common:refund:${approvalId}`,
      cash: { paymentIntentId: 'PAY_refunded', chargeId: 'PAY_refunded' } } };
  const paid = payment({ id: 'PAY_refunded', orderMerchantExternalId: refundOrderId, refundStatus: 'partial', isFullyRefunded: full,
    refundedAmount: { amount: String(netMinor), currency: 'USD' } });
  const refunds = [{ ...ref('REF_settled', refundOrderId), object_type: 'refund' }];
  const run = () => reconcileWaffoPayments(fakeDb({ payment_orders: [order],
    payment_provider_refs: [ref('PAY_refunded', refundOrderId), ...refunds],
    // The daily check follows the old order's binding even after new purchases switch back to Stripe.
    system_settings: [{ key: 'payment_method_routes', value: { version: 5, newPurchaseChannel: 'stripe' } }],
  }, vi.fn()), { merchant: 'fixture', mode: 'test', listPayments: vi.fn().mockResolvedValue({ rows: [paid], complete: true }) });
  return { order, paid, refunds, run };
}
describe('settled Waffo refunds in daily reconciliation', () => {
  it.each([false, true])('accepts an already closed %s refund after new purchases switch back to Stripe', async full => {
    expect(await settledRefundFixture(full).run()).toEqual({ success: true, checkedPayments: 1, complete: true, findings: [] });
  });
  it.each(['amount', 'currency', 'localPending', 'wrongPayment', 'missingRefundMapping', 'missingAmount', 'status', 'extraRefund'])(
    'keeps %s discrepancies visible instead of accepting local status alone', async kind => {
      const f = settledRefundFixture();
      if (kind === 'amount') f.paid.refundedAmount!.amount = '5999';
      if (kind === 'currency') f.paid.refundedAmount!.currency = 'EUR';
      if (kind === 'localPending') f.order.refund_approval.status = 'pending';
      if (kind === 'wrongPayment') f.order.refund_approval.cash.paymentIntentId = 'PAY_other';
      if (kind === 'missingRefundMapping') f.refunds.length = 0;
      if (kind === 'missingAmount') f.paid.refundedAmount = null;
      if (kind === 'status') f.order.payment_status = 'paid';
      if (kind === 'extraRefund') f.paid.refundedAmount!.amount = '6100';
      expect(await f.run()).toMatchObject({ success: false, findings: [{ kind: 'refund_observed', paymentId: 'PAY_refunded' }] });
    });
  it('reports an external unrecorded refunded payment even without a local order mapping', async () => {
    const f = settledRefundFixture();
    const result = await reconcileWaffoPayments(fakeDb({}, vi.fn()), {
      merchant: 'fixture', mode: 'test', listPayments: vi.fn().mockResolvedValue({ rows: [f.paid], complete: true }) });
    expect(result.findings).toEqual([{ kind: 'refund_observed', paymentId: 'PAY_refunded', refundCandidate: false }]);
  });
});

describe('chargebacks arriving after a successful Waffo refund', () => {
  function refundedWithDisputes(full: boolean) {
    const f = settledRefundFixture(full);
    const order = { ...f.order, mode: 'payment', auto_renew: false, qualified_paid_at: '2026-10-11T05:59:48.325Z' };
    const dispute = { id: 'CBK_after_refund', paymentId: 'PAY_refunded', storeId: 'STO_fixture', orderId: 'ORD_fixture1',
      status: 'open', testMode: true, amount: { amount: '100', currency: 'USD' }, createdAt: '2026-10-20T00:00:00.000Z' };
    const rpc = vi.fn().mockResolvedValue({ data: { source_state: 'superseded' }, error: null });
    const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
      readPayment: vi.fn(), readChargebacks: vi.fn().mockResolvedValue([dispute]),
      listPayments: vi.fn().mockResolvedValue({ rows: [f.paid], complete: true }) };
    const run = () => reconcileWaffoPayments(fakeDb({ payment_orders: [order],
      payment_provider_refs: [ref('PAY_refunded', refundOrderId), ...f.refunds] }, rpc), provider, { recover: true });
    return { ...f, rpc, provider, run, dispute };
  }
  it.each([true, false])('records a real chargeback after full=%s refund without fulfilling or refunding again', async full => {
    const f = refundedWithDisputes(full);
    expect(await f.run()).toMatchObject({ success: false, findings: [{ kind: 'chargeback_observed', paymentId: 'PAY_refunded' }] });
    expect(f.provider.readChargebacks).toHaveBeenCalledWith('PAY_refunded', expect.any(Number));
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('pay_failover_dispute_observed', {
      p_order: refundOrderId, p_merchant: 'fixture', p_mode: 'test', p_payment: 'PAY_refunded', p_dispute: 'CBK_after_refund',
      p_amount: 100, p_currency: 'usd', p_observed_at: f.dispute.createdAt });
  });
  it('accepts the real PostgREST timestamptz offset shape for an originally paid source', async () => {
    const f = settledRefundFixture(true);
    const rpc = vi.fn().mockResolvedValue({ data: { source_state: 'superseded' }, error: null });
    const db = fakeDb({ payment_orders: [{ ...f.order, mode: 'payment', auto_renew: false,
      qualified_paid_at: '2026-10-11T05:59:48.325+00:00' }], payment_provider_refs: [ref('PAY_refunded', refundOrderId), ...f.refunds] }, rpc);
    const result = await reconcileWaffoPayments(db, { merchant: 'fixture', mode: 'test', storeId: 'STO_fixture',
      listPayments: vi.fn().mockResolvedValue({ rows: [f.paid], complete: true }), readPayment: vi.fn(),
      readChargebacks: vi.fn().mockResolvedValue([{ id: 'CBK_offset', paymentId: 'PAY_refunded', storeId: 'STO_fixture', orderId: 'ORD_fixture1',
        status: 'open', testMode: true, amount: { amount: '100', currency: 'USD' }, createdAt: '2026-10-20T00:00:00.000Z' }]),
    }, { recover: true });
    expect(result.findings).toEqual([{ kind: 'chargeback_observed', paymentId: 'PAY_refunded', orderId: refundOrderId, refundCandidate: false }]);
    expect(rpc).toHaveBeenCalledWith('pay_failover_dispute_observed', expect.objectContaining({ p_dispute: 'CBK_offset' }));
  });
  it('rejects a foreign PAY from the chargeback lookup without recording it against this source', async () => {
    const f = refundedWithDisputes(true);
    f.provider.readChargebacks.mockResolvedValueOnce([{ ...f.dispute, paymentId: 'PAY_foreign' }]);
    expect(await f.run()).toMatchObject({ success: false, findings: [{ kind: 'recovery_failed' }] });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('holds an unknown dispute amount and currency using NULL while preserving its real identity', async () => {
    const f = refundedWithDisputes(true);
    f.provider.readChargebacks.mockResolvedValueOnce([{ ...f.dispute, amount: null }]);
    expect(await f.run()).toMatchObject({ success: false, findings: [{ kind: 'chargeback_amount_unknown' }] });
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_dispute_observed', expect.objectContaining({
      p_dispute: 'CBK_after_refund', p_amount: null, p_currency: null }));
  });
  it('leaves a settled refund clean when the authoritative chargeback lookup is empty', async () => {
    const f = refundedWithDisputes(true); f.provider.readChargebacks.mockResolvedValueOnce([]);
    expect(await f.run()).toEqual({ success: true, complete: true, checkedPayments: 1, findings: [] });
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
