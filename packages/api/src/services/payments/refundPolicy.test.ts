/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { calculateRefundMoney, refundTime } from './refundMoney';
import { assembleRefundConsumption } from './refundFacts';
import { evaluateRefundPolicy, type RefundPolicyInput } from './refundPolicy';

const paidAt = '2026-10-01T00:00:00.000000Z';
const boundary = '2026-10-08T00:00:00.000000Z';
const observedAt = '2026-10-10T00:00:00Z';
function fixture(): RefundPolicyInput {
  return {
    order: { id: 'order-fixture', userId: 'subject-fixture', channel: 'stripe', mode: 'test', merchant: 'fixture',
      currency: 'usd', paidAt, paidMinor: 6900, refundedMinor: 0, paymentEvidenceRef: 'paid-fixture',
      kind: 'membership_first', refundState: 'none' },
    ticket: { id: 'ticket-fixture', userId: 'subject-fixture', orderId: 'order-fixture', submittedAt: boundary,
      bindingEvidenceRef: 'binding-fixture' },
    observedAt, consumption: { userId: 'subject-fixture', from: paidAt, through: observedAt,
      evidenceRef: 'history-fixture', state: 'unused', completeAccountHistory: true, settlementState: 'clear' },
    accountState: 'active', feePermitted: 'confirmed', reason: 'ordinary',
  };
}

describe('refund window and amount', () => {
  it.each([
    ['2026-10-07T23:59:59.999999Z', 'eligible'],
    [boundary, 'eligible'],
    ['2026-10-08T00:00:00.000001Z', 'rejected'],
  ])('uses ticket submission %s, not delayed approval', (submittedAt, status) => {
    const input = fixture(); input.ticket.submittedAt = submittedAt;
    expect(evaluateRefundPolicy(input).status).toBe(status);
  });
  it('compares UTC +00:00 without losing microseconds', () => {
    expect(refundTime(boundary.replace('Z', '+00:00'))).toBe(refundTime(boundary));
    expect(refundTime('2026-02-30T00:00:00Z')).toBeNull();
    expect(refundTime('2026-10-01')).toBeNull();
    expect(refundTime('2026-10-08T00:00:00.0000001Z')).toBeNull();
  });
  it.each([[6900, 414, 6486], [940, 56, 884], [1, 0, 1], [17, 1, 16]])(
    'floors fixed 6 percent in minor units for %d', (basis, fee, net) => {
      expect(calculateRefundMoney({ paidMinor: basis, basisMinor: basis, refundedMinor: 0 }))
        .toEqual({ basisMinor: basis, feeMinor: fee, netMinor: net, remainingMinor: basis });
    },
  );
  it('does not overflow multiplication at the safe-integer boundary', () => {
    const basis = Number.MAX_SAFE_INTEGER;
    const quote = calculateRefundMoney({ paidMinor: basis, basisMinor: basis, refundedMinor: 0 });
    expect(BigInt(quote.feeMinor)).toBe(BigInt(basis) * 6n / 100n);
    expect(quote.netMinor + quote.feeMinor).toBe(basis);
  });
  it('bounds net refund by remaining actual payment', () => {
    expect(calculateRefundMoney({ paidMinor: 100, basisMinor: 50, refundedMinor: 53 }).netMinor).toBe(47);
    expect(() => calculateRefundMoney({ paidMinor: 100, basisMinor: 50, refundedMinor: 54 })).toThrow();
  });
  it.each([-1, 0, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid basis %s', basisMinor => {
    expect(() => calculateRefundMoney({ paidMinor: 100, refundedMinor: 0, basisMinor })).toThrow();
  });
  it('does not use catalog prices, fixed currency exponents, or a configurable fee', () => {
    const input = fixture(); input.order.currency = 'jpy'; input.order.paidMinor = 999;
    expect(evaluateRefundPolicy(input).quote).toMatchObject({ currency: 'jpy', basisMinor: 999, feeMinor: 59, netMinor: 940 });
    expect(evaluateRefundPolicy({ ...input, feePercent: 0 }).status).toBe('review_required');
  });
});

describe('ordinary eligibility and evidence', () => {
  it.each(['membership_first', 'credit_package', 'pro_to_gold'] as const)('allows %s only as preview', kind => {
    const input = fixture(); input.order.kind = kind;
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'eligible', executable: false,
      reason: 'manual_approval_required', quote: { basisMinor: 6900, feeMinor: 414, netMinor: 6486 } });
  });
  it.each(['pending', 'unknown'] as const)('never treats %s settlements as zero', settlementState => {
    const input = fixture(); input.consumption.settlementState = settlementState;
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'review_required', quote: null });
  });
  it.each([
    ['renewal', (i: RefundPolicyInput) => { i.order.kind = 'renewal'; }],
    ['account_consumed_since_payment', (i: RefundPolicyInput) => { i.consumption.state = 'consumed'; }],
    ['disputed_order', (i: RefundPolicyInput) => { i.order.refundState = 'disputed'; }],
    ['already_refunded', (i: RefundPolicyInput) => { i.order.refundedMinor = 1; }],
    ['already_refunded', (i: RefundPolicyInput) => { i.order.refundState = 'refunded'; }],
    ['violation_terminated', (i: RefundPolicyInput) => { i.accountState = 'violation_terminated'; }],
  ] as const)('rejects %s', (reason, edit) => {
    const input = fixture(); edit(input);
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'rejected', reason, quote: null, executable: false });
  });
  it.each([
    (i: RefundPolicyInput) => { i.ticket.userId = 'another-subject'; },
    (i: RefundPolicyInput) => { i.ticket.orderId = 'another-order'; },
    (i: RefundPolicyInput) => { i.consumption.userId = 'another-subject'; },
    (i: RefundPolicyInput) => { i.ticket.bindingEvidenceRef = ''; },
    (i: RefundPolicyInput) => { i.ticket.submittedAt = '2026-09-30T00:00:00Z'; },
    (i: RefundPolicyInput) => { i.ticket.submittedAt = '2026-10-11T00:00:00Z'; },
    (i: RefundPolicyInput) => { i.consumption.through = boundary; },
    (i: RefundPolicyInput) => { i.consumption.from = boundary; },
    (i: RefundPolicyInput) => { i.consumption.completeAccountHistory = false; },
    (i: RefundPolicyInput) => { i.consumption.state = 'unresolved'; },
    (i: RefundPolicyInput) => { i.order.refundState = 'pending'; },
    (i: RefundPolicyInput) => { i.order.refundState = 'unknown'; },
    (i: RefundPolicyInput) => { i.order.kind = 'unknown'; },
    (i: RefundPolicyInput) => { i.order.paidMinor = 0; },
    (i: RefundPolicyInput) => { i.feePermitted = 'unknown'; },
  ])('requires evidence instead of inferring a safe default (%#)', edit => {
    const input = fixture(); edit(input);
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'review_required', quote: null });
  });
  it('closed account never gains permission to execute or log in', () => {
    const input = fixture(); input.accountState = 'closed';
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'eligible', executable: false });
  });
  it.each([
    ['renewal', (i: RefundPolicyInput) => { i.order.kind = 'renewal'; }],
    ['outside_refund_window', (i: RefundPolicyInput) => { i.ticket.submittedAt = observedAt; }],
    ['account_consumed_since_payment', (i: RefundPolicyInput) => { i.consumption.state = 'consumed'; }],
  ] as const)('rejects known %s before unknown fee evidence', (reason, edit) => {
    const input = fixture(); input.feePermitted = 'unknown'; edit(input);
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'rejected', reason, quote: null });
  });
  it('invalid input fails closed without an exception', () => {
    for (const input of [null, {}, [], 'invalid']) expect(evaluateRefundPolicy(input).status).toBe('review_required');
  });
});

describe('exception preview', () => {
  it.each(['feature_reduction', 'unjust_termination'] as const)('does not apply ordinary exclusions to %s', reason => {
    const input = fixture(); input.reason = reason; input.order.kind = 'renewal';
    input.ticket.submittedAt = observedAt; input.consumption.state = 'consumed';
    expect(evaluateRefundPolicy(input).reason).toBe('exception_contract_amount_required');
    input.exceptionBasis = { reason, orderId: input.order.id, currency: 'usd', basisMinor: 1000, evidenceRef: 'contract-fixture' };
    const result = evaluateRefundPolicy(input);
    expect(result).toMatchObject({ status: 'eligible', executable: false, quote: { feeMinor: 60, netMinor: 940 } });
    expect(result.treatment).toBe(reason === 'feature_reduction'
      ? 'end_membership_keep_granted' : 'end_membership_refund_unused_purchased');
    input.consumption.settlementState = 'unknown';
    expect(evaluateRefundPolicy(input).status).toBe('review_required');
  });
  it('requires matching exception amount evidence and rejects abuse termination', () => {
    const input = fixture(); input.reason = 'unjust_termination';
    input.exceptionBasis = { reason: input.reason, orderId: input.order.id, currency: 'eur', basisMinor: 100, evidenceRef: 'contract' };
    expect(evaluateRefundPolicy(input).reason).toBe('exception_evidence_mismatch');
    input.accountState = 'violation_terminated';
    expect(evaluateRefundPolicy(input).status).toBe('rejected');
  });
});

function history() {
  return { userId: 'subject-fixture', paidAt, observedAt, evidenceRef: 'history-fixture',
    completeAccountHistory: true, settlementState: 'clear', rows: [] as Array<{
      id: string; user_id: string; created_at: string; amount: number | string;
      type: string; ledger_type: string | null; reason_code: string | null;
      counts_as_spend?: boolean; source_type?: string; idempotency_key?: string;
    }> };
}
function row(amount: number | string, type = 'consumption', created_at = boundary) {
  return { id: 'ledger-fixture', user_id: 'subject-fixture', created_at, amount, type,
    ledger_type: ['consumption', 'deduction'].includes(type) ? 'spend' : null, reason_code: null };
}

describe('read-only account-wide consumption assembly', () => {
  it('does not net a returned credit against historical consumption', () => {
    const input = history(); input.rows = [row(-1), { ...row(1, 'refund'), id: 'returned-fixture' }];
    expect(assembleRefundConsumption(input)?.state).toBe('consumed');
  });
  it.each(['consumption', 'deduction'])('recognizes %s independent of source', type => {
    const input = history(); input.rows = [row('-1.000', type)];
    const policy = fixture(); policy.consumption = assembleRefundConsumption(input)!;
    expect(evaluateRefundPolicy(policy).reason).toBe('account_consumed_since_payment');
  });
  it('uses payment time, including same-timestamp spend; ignores earlier consumption', () => {
    const input = history(); input.rows = [row(-1, 'consumption', '2026-09-30T23:59:59.999999Z')];
    expect(assembleRefundConsumption(input)?.state).toBe('unused');
    input.rows[0].created_at = paidAt;
    expect(assembleRefundConsumption(input)?.state).toBe('consumed');
  });
  it('cannot approve incomplete reads, pending holds, or unknown settlements', () => {
    const input = history(); input.completeAccountHistory = false;
    expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
    input.completeAccountHistory = true;
    for (const settlementState of ['pending', 'unknown']) {
      input.settlementState = settlementState;
      expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
    }
  });
  it('unclassified debit is unresolved, not assumed to be a harmless adjustment', () => {
    const input = history(); input.rows = [row(-1, 'adjustment')];
    expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
  });
  it('does not misclassify a settled reservation as consumption', () => {
    const input = history(); input.rows = [{ ...row(-100, 'adjustment'), reason_code: 'bill2_reserve' }];
    expect(assembleRefundConsumption(input)?.state).toBe('unused');
    input.settlementState = 'pending';
    expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
  });
  it('rejects wrong subject, duplicates, future rows and malformed values', () => {
    const input = history(); input.rows = [{ ...row(-1), user_id: 'another-subject' }];
    expect(assembleRefundConsumption(input)).toBeNull();
    input.rows = [row(-1), row(-1)]; expect(assembleRefundConsumption(input)).toBeNull();
    input.rows = [row(-1, 'consumption', '2026-10-11T00:00:00Z')]; expect(assembleRefundConsumption(input)).toBeNull();
    input.rows = [row('not-money')]; expect(assembleRefundConsumption(input)).toBeNull();
  });
  it('preserves uncertainty even when a definite consumption already rejects ordinary refunds', () => {
    const input = history(); input.rows = [row(-1), { ...row(-2, 'adjustment'), id: 'unknown-debit' }];
    expect(assembleRefundConsumption(input)).toMatchObject({ state: 'consumed', settlementState: 'unknown' });
  });
  it.each(['refund_clawback', 'adjustment', 'expiration'])('does not count authoritative %s as consumption', ledger_type => {
    const input = history(); input.rows = [{ ...row(-1, 'deduction'), ledger_type, counts_as_spend: false }];
    expect(assembleRefundConsumption(input)?.state).toBe('unused');
    const policy = fixture(); policy.consumption = assembleRefundConsumption(input)!;
    expect(evaluateRefundPolicy(policy).status).toBe('eligible');
  });
  it('uses existing legacy normalization and refuses conflicting semantics', () => {
    const input = history();
    input.rows = [{ ...row(-1), ledger_type: null, source_type: 'ai_task' }];
    expect(assembleRefundConsumption(input)?.state).toBe('consumed');
    input.rows = [{ ...row(-1), ledger_type: null, source_type: 'admin' }];
    expect(assembleRefundConsumption(input)?.state).toBe('unused');
    input.rows = [{ ...row(-1), ledger_type: 'spend', counts_as_spend: false }];
    expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
    input.rows = [{ ...row(-1), ledger_type: 'new-unknown-type' }];
    expect(assembleRefundConsumption(input)?.state).toBe('unresolved');
  });
  it('quotes the full eligible amount when a verified prohibition disallows the fee', () => {
    const input = fixture(); input.feePermitted = 'not_permitted';
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'eligible', executable: false,
      quote: { basisMinor: 6900, feeMinor: 0, netMinor: 6900 } });
    input.feePermitted = 'unknown';
    expect(evaluateRefundPolicy(input)).toMatchObject({ status: 'review_required', quote: null });
  });
  it('does not mutate supplied evidence', () => {
    const input = history(); input.rows = [row(-1)]; const copy = JSON.stringify(input);
    assembleRefundConsumption(input); expect(JSON.stringify(input)).toBe(copy);
    const policy = fixture(); const snapshot = JSON.stringify(policy);
    evaluateRefundPolicy(policy); expect(JSON.stringify(policy)).toBe(snapshot);
  });
});
