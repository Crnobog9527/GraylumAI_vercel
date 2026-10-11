/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { reconcileWaffoPayments } from './waffoReconciliation';
import { fakeDb, payment } from './waffoTestHarness';

const ref = (external_id: string, order_id: string) => ({ external_id, order_id, channel: 'waffo', merchant_namespace: 'fixture',
  mode: 'test', object_type: 'payment' });
describe('Waffo daily reconciliation (report only)', () => {
  it('lists paid-but-undelivered, refund candidates and delivered-without-payment; grants nothing', async () => {
    const rows = [payment({ id: 'PAY_ok' }), payment({ id: 'PAY_missing' }), payment({ id: 'PAY_renewal_after_cancel' }),
      payment({ id: 'PAY_offsite' }), payment({ id: 'PAY_refunded', refundStatus: 'succeeded', refundedAmount: { amount: '6900', currency: 'USD' } }),
      payment({ id: 'PAY_failed', status: 'failed' })];
    const rpc = vi.fn();
    const db = fakeDb({
      payment_provider_refs: [ref('PAY_ok', 'o-ok'), ref('PAY_renewal_after_cancel', 'o-review'), ref('PAY_refunded', 'o-refunded'),
        ref('PAY_ghost', 'o-ghost')],
      payment_orders: [{ id: 'o-ok', fulfilled_at: '2026-10-11T06:00:00Z' },
        { id: 'o-review', fulfilled_at: null, qualification_state: 'review', method_review_reason: 'unexpected_renewal' },
        { id: 'o-refunded', fulfilled_at: '2026-10-11T06:00:00Z' }, { id: 'o-ghost', fulfilled_at: '2026-10-11T06:00:00Z' }],
      waffo_event_receipts: [{ merchant_namespace: 'fixture', mode: 'test', resolution: { kind: 'offsite', cash: { paymentId: 'PAY_offsite' } } }],
    }, rpc);
    const listPayments = vi.fn().mockResolvedValue({ rows, complete: true });
    const result = await reconcileWaffoPayments(db, { merchant: 'fixture', mode: 'test', listPayments });
    expect(result.success).toBe(false);
    expect(result.findings).toEqual([
      { kind: 'paid_not_delivered', paymentId: 'PAY_missing', refundCandidate: false },
      { kind: 'paid_in_review', paymentId: 'PAY_renewal_after_cancel', orderId: 'o-review', reason: 'unexpected_renewal', refundCandidate: true },
      { kind: 'offsite_refund_due', paymentId: 'PAY_offsite', refundCandidate: true },
      { kind: 'refund_observed', paymentId: 'PAY_refunded', orderId: 'o-refunded', refundCandidate: false },
      { kind: 'delivered_without_payment', paymentId: 'PAY_ghost', orderId: 'o-ghost', refundCandidate: false },
    ]);
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
