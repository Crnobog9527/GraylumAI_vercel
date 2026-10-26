/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The current payment model's records as the daily readiness audit (billingReconciliation.ts) reads them.
import type { PaymentOrderRow } from './billingReadinessRows';

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The current payment model's refund records (REL-1 2026-10-26: every current refund was reported as unaudited because
 * only the legacy Stripe keys were read): an approved refund (monthly, wallet, Waffo) ends with refund_approval.status
 * 'succeeded' (0253, PAY-FAILOVER); a refund made outside Graylum, or a test-clock close, records the provider refund id
 * in metadata.stripeExternalRefund (0247), including the partial and pack states that go to review; a test-clock close
 * (0329) records its refunds in stripeTestClockClose.
 */
const EXTERNAL_REFUND_STATES = new Set<string>(['refunded', 'partial_review', 'pack_review']);
export function hasCurrentRefundRecord(order: PaymentOrderRow) {
  const metadata = asRecord(order.metadata);
  const external = asRecord(metadata.stripeExternalRefund);
  // A test-clock close (0329) keeps the provider refunds in stripeTestClockClose.refunds instead of lastRefundId.
  const clockRefunds = asRecord(metadata.stripeTestClockClose).refunds;
  const clockRefunded = external.neverFulfilled === true && Array.isArray(clockRefunds)
    && clockRefunds.length > 0 && clockRefunds.every((refund) => typeof asRecord(refund).id === 'string');
  return normalizeText(asRecord(order.refund_approval).status) === 'succeeded'
    || ((typeof external.lastRefundId === 'string' || clockRefunded) && EXTERNAL_REFUND_STATES.has(normalizeText(external.state)));
}

/** A current-model order is one without the legacy Stripe subscription id: its grants and ledger rows carry the order. */
export function isCurrentModelOrder(order: PaymentOrderRow) {
  return !order.stripe_subscription_id?.trim();
}

/** Current-model grant period keys are `payment:<order id>:<period>` (pay_waffo_grant_period). */
export function grantOrderId(grantPeriodKey: string | null | undefined) {
  const match = /^payment:([0-9a-f-]{36}):\d+$/i.exec(grantPeriodKey?.trim() ?? '');
  return match ? match[1]!.toLowerCase() : null;
}
