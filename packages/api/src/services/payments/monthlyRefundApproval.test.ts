/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { prepareMonthlyRefundQuote, monthlyRefundVersion } from './monthlyRefundApproval';
import { quoteInput } from './__tests__/monthlyRefundExecutionFixture';

describe('monthly first purchase approval material (not approval)', () => {
  it.each(['pro', 'gold'] as const)('reuses fixed fee and exact original credits for %s', plan => {
    const { policy, binding } = quoteInput(); binding.plan = plan;
    const result = prepareMonthlyRefundQuote(policy, binding);
    expect(result).toMatchObject({ status: 'eligible', quote: { executable: false,
      terms: { plan, basisMinor: 6900, feeMinor: 414, netMinor: 6486, credits: 8970 } } });
  });
  it.each(['yearly', 'one_time', 'unknown'])('rejects unsupported %s cycle', billingCycle => {
    const { policy, binding } = quoteInput(); binding.billingCycle = billingCycle;
    expect(prepareMonthlyRefundQuote(policy, binding)).toMatchObject({ status: 'review_required', executable: false });
  });
  it('does not recognize a founder price as ordinary monthly evidence', () => {
    const { policy, binding } = quoteInput();
    binding.snapshot = { ...binding.snapshot as object, billing_cycle: 'yearly', price: '496' };
    expect(prepareMonthlyRefundQuote(policy, binding).status).toBe('review_required');
  });
  type Input = ReturnType<typeof quoteInput>;
  const rejected: Array<[string, (f: Input) => void]> = [
    ['unknown plan', f => { f.binding.plan = 'unknown'; }],
    ['closed subject', f => { f.policy.accountState = 'closed'; }],
    ['unknown subject', f => { f.policy.accountState = 'unknown'; }],
    ['violation', f => { f.policy.accountState = 'violation_terminated'; }],
    ['other user', f => { f.binding.userId = 'different'; }],
    ['other order', f => { f.binding.orderId = 'different'; }],
    ['wrong credits', f => { f.binding.credits = 8432; }],
    ['renewal', f => { f.policy.order.kind = 'renewal'; }],
    ['upgrade', f => { f.policy.order.kind = 'pro_to_gold'; }],
    ['waffo', f => { f.policy.order.channel = 'waffo'; }],
    ['live', f => { f.policy.order.mode = 'live'; }],
    ['consumed', f => { f.policy.consumption.state = 'consumed'; }],
    ['hold from before payment', f => { f.policy.consumption.settlementState = 'pending'; }],
    ['missing history', f => { f.policy.membershipHistory = undefined; }],
    ['prior purchase', f => { f.policy.membershipHistory!.priorPaidMembershipCount = 1; }],
    ['incomplete ledger', f => { f.policy.consumption.completeAccountHistory = false; }],
    ['unknown fee', f => { f.policy.feePermitted = 'unknown'; }],
    ['no fee evidence', f => { f.binding.feeEvidence = ''; }],
    ['dispute', f => { f.policy.order.refundState = 'disputed'; }],
    ['previous refund', f => { f.policy.order.refundState = 'partial'; f.policy.order.refundedMinor = 1; }],
    ['period ended', f => { f.binding.periodEnd = f.policy.observedAt; }],
    ['snapshot missing', f => { f.binding.snapshot = null; }],
  ];
  it.each(rejected)('fails closed: %s', (_, change) => {
    const f = quoteInput(); change(f);
    expect(prepareMonthlyRefundQuote(f.policy, f.binding).status).not.toBe('eligible');
  });
  it.each([
    ['2026-10-07T23:59:59.999999Z', 'eligible'],
    ['2026-10-08T00:00:00.000000Z', 'eligible'],
    ['2026-10-08T00:00:00.000001Z', 'rejected'],
  ])('uses exact ticket time %s even with delayed processing', (submittedAt, status) => {
    const { policy, binding } = quoteInput();
    policy.ticket.submittedAt = submittedAt;
    policy.observedAt = policy.consumption.through = '2026-10-09T00:00:00Z';
    expect(prepareMonthlyRefundQuote(policy, binding).status).toBe(status);
  });
  it('uses zero fee only with verified prohibition, without changing credits', () => {
    const { policy, binding } = quoteInput(); policy.feePermitted = 'not_permitted';
    expect(prepareMonthlyRefundQuote(policy, binding)).toMatchObject({ quote: {
      terms: { feeMinor: 0, netMinor: 6900, credits: 8970 }, executable: false } });
  });
  it('has a stable version and binds fee evidence, identities and original renewal preference', () => {
    const { policy, binding } = quoteInput();
    const first = prepareMonthlyRefundQuote(policy, binding);
    expect(prepareMonthlyRefundQuote(policy, binding)).toEqual(first);
    expect(first.status).toBe('eligible');
    if (first.status !== 'eligible') throw new Error('fixture');
    for (const patch of [{ feeEvidence: 'different' }, { ticketId: 'different' }, { originalCancelAtPeriodEnd: true }]) {
      expect(monthlyRefundVersion({ ...first.quote.terms, ...patch })).not.toBe(first.quote.versionHash);
    }
    policy.observedAt = policy.consumption.through = '2026-10-07T12:01:00Z';
    expect(prepareMonthlyRefundQuote(policy, binding)).toEqual(first);
  });
  it('copies evidence without mutating the caller and never persists an approval', () => {
    const f = quoteInput(); const before = structuredClone(f);
    const result = prepareMonthlyRefundQuote(f.policy, f.binding);
    expect(f).toEqual(before);
    if (result.status !== 'eligible') throw new Error('fixture');
    result.quote.terms.evidenceRefs.push('new');
    expect(f).toEqual(before);
    expect(result.quote.executable).toBe(false);
  });
});
