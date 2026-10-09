/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  canExecuteMonthlyRefund, canRejectMonthlyRefund, executeReasonLabel, stoppedExecutionReason, monthlyRefundStages, monthlyRefundStatusLabel,
  validateMonthlyRefundForm, validateRefundFields,
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
