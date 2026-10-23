/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  canExecuteMonthlyRefund, canRejectMonthlyRefund, executeReasonLabel, stopAllowsRetry, stoppedExecutionReason, monthlyRefundStages, monthlyRefundStatusLabel,
  validateMonthlyRefundForm, validateRefundFields, EMPTY_MONTHLY_REFUND_FORM, FEE_UNKNOWN_EVIDENCE, feePermittedPatch,
} from './monthlyRefundView';

const ORDER = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';

describe('validateMonthlyRefundForm', () => {
  it('trims and returns the exact server input when every field is valid', () => {
    expect(validateMonthlyRefundForm({ orderId: ` ${ORDER} `, ticketId: TICKET, feePermitted: 'confirmed',
      feeEvidence: ' legal:us-ca:2026-10 ' })).toEqual({ ok: true, request: {
      orderId: ORDER, ticketId: TICKET, feePermitted: 'confirmed', feeEvidence: 'legal:us-ca:2026-10' } });
  });

  it('reports every invalid field instead of calling the server', () => {
    const result = validateMonthlyRefundForm({ orderId: 'abc', ticketId: '', feePermitted: '', feeEvidence: '中文 依据' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['feeEvidence', 'feePermitted', 'orderId', 'ticketId']);
  });

  it('rejects evidence longer than the server limit', () => {
    const result = validateMonthlyRefundForm({ orderId: ORDER, ticketId: TICKET, feePermitted: 'not_permitted',
      feeEvidence: 'a'.repeat(161) });
    expect(result.ok).toBe(false);
  });
});

describe('validateRefundFields', () => {
  it('checks only what each action sends', () => {
    const form = { orderId: ORDER, ticketId: '', feePermitted: '' as const, feeEvidence: '' };
    expect(validateRefundFields(form, 'status')).toEqual({});
    expect(Object.keys(validateRefundFields(form, 'reject'))).toEqual(['ticketId']);
    expect(Object.keys(validateRefundFields(form, 'quote')).sort()).toEqual(['feeEvidence', 'feePermitted', 'ticketId']);
  });
});

describe('intent presentation', () => {
  it('labels unknown values as unknown instead of guessing', () => {
    expect(monthlyRefundStatusLabel('approved')).toBe('已批准，等待执行');
    expect(monthlyRefundStatusLabel('something_new')).toBe('未知状态');
    expect(executeReasonLabel('bounded_reconciliation')).toContain('继续执行');
    expect(executeReasonLabel(undefined)).toBe('需要人工核对，请先查看进度');
    expect(executeReasonLabel('stage_order_invalid')).toContain('原因代码 stage_order_invalid');
  });

  it('reads the stop reason at the top level or inside the planner decision', () => {
    expect(stoppedExecutionReason({ reason: 'recorded_cash_conflict' })).toBe('recorded_cash_conflict');
    expect(stoppedExecutionReason({ decision: { kind: 'review_required', reason: 'amount_mismatch' } })).toBe('amount_mismatch');
    expect(stoppedExecutionReason({ decision: { kind: 'pending', refundId: 're_1' } })).toBe('refund_pending');
    expect(stoppedExecutionReason(null)).toBeUndefined();
  });

  it('offers another pass only for stops the executor can retry', () => {
    for (const reason of ['refund_pending', 'bounded_reconciliation', 'fresh_observation_required']) {
      expect(stopAllowsRetry(reason)).toBe(true);
    }
    for (const reason of ['amount_mismatch', 'post_retry_window_elapsed', 'approval_changed', 'account_unresolved',
      'recorded_cash_conflict', 'something_new', undefined]) expect(stopAllowsRetry(reason)).toBe(false);
  });

  it('lists every stage in order and marks unstarted ones', () => {
    expect(monthlyRefundStages({ stop_renewal: '2026-10-09T00:00:00Z', refund: null })).toEqual([
      { key: 'stop_renewal', label: '停止自动续费', startedAt: '2026-10-09T00:00:00Z' },
      { key: 'refund', label: '向支付商发起退款', startedAt: null },
      { key: 'cancel', label: '取消订阅', startedAt: null },
      { key: 'restore_renewal', label: '恢复自动续费', startedAt: null },
    ]);
  });

  it('only offers execute for approved or in-progress intents and reject before execution starts', () => {
    expect(canExecuteMonthlyRefund({ id: 'i', status: 'approved' })).toBe(true);
    expect(canExecuteMonthlyRefund({ id: 'i', status: 'review_required' })).toBe(true);
    expect(canExecuteMonthlyRefund({ id: 'i', status: 'succeeded' })).toBe(false);
    expect(canExecuteMonthlyRefund({ id: 'i', status: 'rejected' })).toBe(false);
    expect(canExecuteMonthlyRefund(null)).toBe(false);
    expect(canRejectMonthlyRefund(null)).toBe(true);
    expect(canRejectMonthlyRefund({ status: 'approved', claimedAt: null })).toBe(true);
    expect(canRejectMonthlyRefund({ status: 'review_required', claimedAt: '2026-10-09T00:00:00Z' })).toBe(false);
    expect(canRejectMonthlyRefund({ status: 'rejected' })).toBe(false);
  });
});

describe('fee default (location unknown means no fee)', () => {
  it('starts on not_permitted with the placeholder basis, which passes the quote checks', () => {
    expect(EMPTY_MONTHLY_REFUND_FORM.feePermitted).toBe('not_permitted');
    expect(EMPTY_MONTHLY_REFUND_FORM.feeEvidence).toBe('location-unknown-no-fee');
    expect(validateRefundFields({ ...EMPTY_MONTHLY_REFUND_FORM, orderId: ORDER, ticketId: TICKET }, 'quote')).toEqual({});
  });

  it('clears the placeholder when switching to deduct, so a real basis is required', () => {
    const patch = feePermittedPatch('confirmed', EMPTY_MONTHLY_REFUND_FORM);
    expect(patch).toEqual({ feePermitted: 'confirmed', feeEvidence: '' });
    expect(Object.keys(validateRefundFields({ ...EMPTY_MONTHLY_REFUND_FORM, ...patch }, 'quote'))).toContain('feeEvidence');
  });

  it('keeps a typed basis and restores the placeholder only when the basis is empty', () => {
    const typed = { ...EMPTY_MONTHLY_REFUND_FORM, feePermitted: 'confirmed' as const, feeEvidence: 'legal:us-ca:2026-10' };
    expect(feePermittedPatch('not_permitted', typed)).toEqual({ feePermitted: 'not_permitted', feeEvidence: 'legal:us-ca:2026-10' });
    expect(feePermittedPatch('not_permitted', { ...typed, feeEvidence: '' }))
      .toEqual({ feePermitted: 'not_permitted', feeEvidence: FEE_UNKNOWN_EVIDENCE });
    expect(feePermittedPatch('confirmed', typed)).toEqual({ feePermitted: 'confirmed', feeEvidence: 'legal:us-ca:2026-10' });
  });
});
