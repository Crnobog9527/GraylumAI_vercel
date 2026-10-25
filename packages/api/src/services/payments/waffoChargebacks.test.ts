/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { chargebackCash, holdWaffoChargebacks } from './waffoChargebacks';
import { fakeDb } from './waffoTestHarness';
import type { WaffoChargeback } from './waffoTestOperationsClient';

const orderId = '00000000-0000-4000-8000-000000000071';
const chargeback = (overrides: Partial<WaffoChargeback> = {}): WaffoChargeback => ({ id: 'CBK_delivered', paymentId: 'PAY_delivered',
  storeId: 'STO_fixture', orderId: 'ORD_fixture1', status: 'open', testMode: true, amount: { amount: '6900', currency: 'USD' },
  createdAt: '2026-10-25T00:00:00.000Z', expiryDateTime: '2026-11-04T00:00:00.000Z', ...overrides });
function fixture(disputes: WaffoChargeback[], saved: Record<string, unknown> = {}) {
  const row = { id: 'dispute-1', freeze_state: 'frozen', source_review_required: false, alerted_at: null,
    freeze_alerted_at: null, evidence_due_by: null, ...saved };
  const tables = {
    payment_provider_refs: [{ external_id: 'PAY_delivered', order_id: orderId, channel: 'waffo', merchant_namespace: 'fixture',
      mode: 'test', object_type: 'payment' }],
    payment_orders: [{ id: orderId, currency: 'usd', amount_total: 6900, payment_channel: 'waffo', merchant_namespace: 'fixture',
      payment_mode: 'test' }],
    payment_disputes: [row],
  };
  // The SQL function is idempotent per Waffo chargeback id: every call returns the same persisted row.
  const rpc = vi.fn().mockImplementation(async () => ({ data: row, error: null }));
  const provider = { merchant: 'fixture', mode: 'test' as const, storeId: 'STO_fixture',
    listChargebacks: vi.fn().mockResolvedValue(disputes) };
  const alert = vi.fn();
  const run = (withAlert = true, deadline = Date.now() + 10_000) =>
    holdWaffoChargebacks(fakeDb(tables, rpc), provider, deadline, withAlert ? alert : undefined);
  return { row, rpc, provider, alert, run };
}

describe('Waffo chargebacks found by the daily scan', () => {
  it('holds a chargeback on an already delivered payment through the shared dispute function, reported once', async () => {
    const f = fixture([chargeback()]);
    expect(await f.run()).toEqual({ complete: true, disputedPayments: new Set(['PAY_delivered']),
      findings: [{ kind: 'chargeback_observed', paymentId: 'PAY_delivered', orderId, refundCandidate: false }] });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('pay_failover_dispute_observed', { p_order: orderId, p_merchant: 'fixture',
      p_mode: 'test', p_payment: 'PAY_delivered', p_dispute: 'CBK_delivered', p_amount: 6900, p_currency: 'usd',
      p_observed_at: '2026-10-25T00:00:00.000Z' });
    expect(f.alert).toHaveBeenCalledExactlyOnceWith({ code: 'PAY_DISPUTE_PAYMENT_FROZEN', disputeId: 'dispute-1',
      dueBy: '2026-11-04T00:00:00.000Z' });
    expect(f.row).toMatchObject({ evidence_due_by: '2026-11-04T00:00:00.000Z', alerted_at: expect.any(String),
      freeze_alerted_at: expect.any(String) });
    // Next day: the same chargeback is seen again; the hold function is idempotent and nothing is re-reported.
    expect(await f.run()).toMatchObject({ complete: true, findings: [] });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.alert).toHaveBeenCalledTimes(1);
  });
  it('keeps reporting while no alert channel can record that it was reported', async () => {
    const f = fixture([chargeback()]);
    for (let day = 0; day < 2; day++) expect((await f.run(false)).findings).toHaveLength(1);
    expect(f.row.alerted_at).toBeNull();
  });
  it('holds an unknown amount without inventing a full loss and asks for source review', async () => {
    const f = fixture([chargeback({ amount: null })], { source_review_required: true });
    expect((await f.run()).findings).toEqual([{ kind: 'chargeback_amount_unknown', paymentId: 'PAY_delivered', orderId,
      refundCandidate: false }]);
    expect(f.rpc).toHaveBeenCalledWith('pay_failover_dispute_observed', expect.objectContaining({ p_amount: null, p_currency: null }));
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_DISPUTE_SOURCE_REVIEW' }));
  });
  it('reports a chargeback on an already refunded payment without a second hold', async () => {
    const f = fixture([chargeback()], { freeze_state: 'superseded' });
    await f.run();
    expect(f.alert).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAY_DISPUTE_REFUNDED_PAYMENT' }));
    expect(f.row.freeze_alerted_at).toBeNull();
  });
  it('reports chargebacks on payments that are not ours, and keeps going after one failed hold', async () => {
    const f = fixture([chargeback({ id: 'CBK_offsite', paymentId: 'PAY_offsite' }), chargeback({ id: 'CBK_none', paymentId: null }),
      chargeback({ id: 'CBK_failing' }), chargeback()]);
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'PAY_FAILOVER_DISPUTE_SCOPE' } });
    expect((await f.run()).findings).toEqual([
      { kind: 'chargeback_unmatched', paymentId: 'PAY_offsite', refundCandidate: false },
      { kind: 'chargeback_unmatched', paymentId: undefined, refundCandidate: false },
      { kind: 'recovery_failed', paymentId: 'PAY_delivered', orderId, refundCandidate: false },
      { kind: 'chargeback_observed', paymentId: 'PAY_delivered', orderId, refundCandidate: false },
    ]);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('rejects a list that leaks another store or mode before touching any order', async () => {
    for (const leak of [{ storeId: 'STO_other' }, { testMode: false }, { createdAt: 'yesterday' }]) {
      const f = fixture([chargeback(leak)]);
      await expect(f.run()).rejects.toThrow('PAY_WAFFO_OPERATION_SCOPE');
      expect(f.rpc).not.toHaveBeenCalled();
    }
  });
  it('stops at the deadline and says the scan is incomplete', async () => {
    const f = fixture([chargeback()]);
    expect(await f.run(true, Date.now() - 1)).toMatchObject({ complete: false, findings: [] });
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe('chargeback cash facts', () => {
  it('never turns an inconsistent amount into a made-up loss', () => {
    expect(chargebackCash(chargeback(), 'usd', 6900)).toEqual({ amount: 6900, currency: 'usd', unknown: false });
    expect(chargebackCash(chargeback(), 'usd', 100)).toEqual({ amount: null, currency: 'usd', unknown: true });
    expect(chargebackCash(chargeback({ amount: { amount: '6900', currency: 'EUR' } }), 'usd', 6900))
      .toEqual({ amount: 6900, currency: 'eur', unknown: true });
  });
});
