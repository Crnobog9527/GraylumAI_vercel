/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RefundPolicyInput } from '../refundPolicy';
import { prepareMonthlyRefundQuote } from '../monthlyRefundApproval';
import type { MonthlyRefundIntent, MonthlyRefundObservation } from '../subscriptionRefundExecution';

export const now = '2026-10-07T12:00:00Z';
export function quoteInput() {
  const paidAt = '2026-10-01T00:00:00Z';
  const policy: RefundPolicyInput = {
    order: { id: 'order-fixture', userId: 'user-fixture', channel: 'stripe', mode: 'test', merchant: 'merchant-fixture',
      currency: 'usd', paidAt, paidMinor: 6900, refundedMinor: 0, paymentEvidenceRef: 'cash-fixture',
      kind: 'membership_first', refundState: 'none' },
    ticket: { id: 'ticket-fixture', userId: 'user-fixture', orderId: 'order-fixture', submittedAt: now,
      bindingEvidenceRef: 'ticket-binding-fixture' },
    observedAt: now, membershipHistory: { userId: 'user-fixture', orderId: 'order-fixture', paidAt,
      evidenceRef: 'membership-history-fixture', complete: true, priorPaidMembershipCount: 0 },
    consumption: { userId: 'user-fixture', from: paidAt, through: now, evidenceRef: 'consumption-fixture',
      state: 'unused', completeAccountHistory: true, settlementState: 'clear' },
    accountState: 'active', feePermitted: 'confirmed', reason: 'ordinary',
  };
  const binding: Parameters<typeof prepareMonthlyRefundQuote>[1] = {
    orderId: 'order-fixture', userId: 'user-fixture', subscriptionId: 'subscription-fixture',
    providerSubscriptionId: 'sub_fixture', paymentIntentId: 'pi_fixture', chargeId: 'ch_fixture', invoiceId: 'in_fixture',
    plan: 'gold', billingCycle: 'monthly', periodEnd: '2026-11-01T00:00:00Z', originalCancelAtPeriodEnd: false,
    credits: 8970, feeEvidence: 'legal-basis-fixture',
    snapshot: { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-000000000001',
      item_updated_at: '2026-09-01T00:00:00Z', billing_cycle: 'monthly', currency: 'usd', unit: 'major',
      price: '69', discount: '0', tax_behavior: 'exclusive', credits: 8970, bonus_credits: 0 },
  };
  return { policy, binding };
}
export function executionFixture() {
  const input = quoteInput();
  const result = prepareMonthlyRefundQuote(input.policy, input.binding);
  if (result.status !== 'eligible') throw new Error('Fixture is not eligible');
  const intent: MonthlyRefundIntent = {
    id: '00000000-0000-4000-8000-000000000002', terms: result.quote.terms, versionHash: result.quote.versionHash,
    claimedAt: null, started: { stop_renewal: null, refund: null, cancel: null, restore_renewal: null }, recordedRefund: null,
  };
  const seen: MonthlyRefundObservation = {
    checkedAt: now, merchant: 'merchant-fixture', mode: 'test',
    local: { adminActive: true, account: 'active', approvalVersion: intent.versionHash, eligibility: 'unchanged', hold: 'none' },
    subscription: { id: 'sub_fixture', status: 'active', periodEnd: intent.terms.periodEnd,
      cancelAtPeriodEnd: false, renewalOwnership: 'original', preflight: 'clear' },
    refunds: { complete: true, rows: [] },
  };
  return { intent, seen };
}
export function claimedFixture() {
  const f = executionFixture();
  f.intent.claimedAt = now;
  f.seen.local.hold = 'held';
  return f;
}
export function stoppedFixture() {
  const f = claimedFixture();
  f.intent.started.stop_renewal = now;
  f.seen.subscription.cancelAtPeriodEnd = true;
  f.seen.subscription.renewalOwnership = 'intent';
  return f;
}
export function refundFixture(status: MonthlyRefundObservation['refunds']['rows'][number]['status'] = 'succeeded') {
  const f = stoppedFixture();
  f.intent.started.refund = now;
  f.seen.refunds.rows.push({ id: 're_fixture', intentId: f.intent.id, orderId: f.intent.terms.orderId,
    chargeId: 'ch_fixture', paymentIntentId: 'pi_fixture', currency: 'usd', amount: f.intent.terms.netMinor,
    merchant: 'merchant-fixture', mode: 'test', status });
  return f;
}
