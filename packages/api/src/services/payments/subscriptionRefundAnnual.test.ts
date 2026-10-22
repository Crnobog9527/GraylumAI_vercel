/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { describe, expect, it } from 'vitest';
import { prepareMonthlyRefundQuote, monthlyRefundVersion } from './monthlyRefundApproval';
import { planMonthlyRefundStep } from './subscriptionRefundExecution';
import { quoteInput, refundFixture, now } from './__tests__/monthlyRefundExecutionFixture';

function annual(plan: 'pro' | 'gold' = 'gold') {
  const f = quoteInput();
  f.binding.billingCycle = 'yearly';
  f.binding.plan = plan;
  f.binding.periodEnd = '2027-10-01T00:00:00Z';
  f.binding.snapshot = { ...f.binding.snapshot as object, billing_cycle: 'yearly',
    credits: 8970 * 12, price: '496' };
  return f;
}
describe('Stripe annual and founder first-purchase refund through the shared subscription state machine', () => {
  it.each(['pro', 'gold'] as const)('quotes %s annual first purchase using only already granted credits', plan => {
    const f = annual(plan);
    expect(prepareMonthlyRefundQuote(f.policy, f.binding)).toMatchObject({ status: 'eligible',
      quote: { terms: { credits: 8970, snapshot: { billing_cycle: 'yearly', credits: 107640 } } } });
    f.binding.credits *= 2;
    expect(prepareMonthlyRefundQuote(f.policy, f.binding)).toMatchObject({ status: 'eligible',
      quote: { terms: { credits: 17940 } } });
  });
  it.each(['spent', 'late', 'renewal', 'wrongCycle', 'tooManyCredits'])('rejects %s without dispatch', reason => {
    const f = annual();
    if (reason === 'spent') f.policy.consumption.state = 'consumed';
    if (reason === 'late') f.policy.ticket.submittedAt = '2026-10-08T00:00:00.000001Z';
    if (reason === 'renewal') f.policy.order.kind = 'renewal';
    if (reason === 'wrongCycle') f.binding.billingCycle = 'monthly';
    if (reason === 'tooManyCredits') f.binding.credits = 107641;
    expect(prepareMonthlyRefundQuote(f.policy, f.binding).status).not.toBe('eligible');
  });
  it('quotes the verified Pro -> Gold upgrade and binds its recovery evidence into the version', () => {
    const f = annual();
    f.policy.order.kind = 'pro_to_gold';
    f.policy.membershipHistory!.priorPaidMembershipCount = 1;
    f.binding.priorPro = { orderId: 'prior-order', subscriptionId: 'prior-sub', providerSubscriptionId: 'sub_prior',
      invoiceId: 'in_prior', periodEnd: '2027-01-01T00:00:00Z' };
    const result = prepareMonthlyRefundQuote(f.policy, f.binding);
    expect(result).toMatchObject({ status: 'eligible', quote: { terms: { priorPro: f.binding.priorPro } } });
    if (result.status !== 'eligible') throw new Error('fixture');
    expect(result.quote.terms.evidenceRefs.length).toBeGreaterThanOrEqual(4);
    const before = result.quote.versionHash;
    f.binding.priorPro.periodEnd = '2027-02-01T00:00:00Z';
    const after = prepareMonthlyRefundQuote(f.policy, f.binding);
    expect(after.status === 'eligible' && after.quote.versionHash).not.toBe(before);
  });
  it('executes annual cash success using the shared cancellation decision and version binding', () => {
    const f = refundFixture();
    f.intent.terms.snapshot.billing_cycle = 'yearly';
    f.intent.terms.snapshot.credits *= 12;
    f.intent.versionHash = f.seen.local.approvalVersion = monthlyRefundVersion(f.intent.terms);
    f.intent.recordedRefund = { id: 're_fixture', status: 'succeeded' };
    expect(planMonthlyRefundStep(f.intent, f.seen, now)).toMatchObject({ kind: 'record_before_dispatch', stage: 'cancel' });
    f.seen.subscription.status = 'canceled';
    f.seen.subscription.cancelAtPeriodEnd = false;
    expect(planMonthlyRefundStep(f.intent, f.seen, now)).toMatchObject({ kind: 'finalize_success' });
    f.seen.subscription.cancelAtPeriodEnd = true;
    expect(planMonthlyRefundStep(f.intent, f.seen, now)).toMatchObject({ kind: 'review_required', reason: 'renewal_state_changed' });
  });
});
