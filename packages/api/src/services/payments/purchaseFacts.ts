/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { freezePurchaseSnapshot, type PurchaseSnapshot } from './contracts';

/** Marks a stop or cancellation Graylum asked Stripe for (review stop, monthly refund), as opposed to the buyer's own:
 * Stripe reports both as cancellation_requested, and only the buyer's own ends the founder renewal window. Stripe
 * replaces cancellation_details on every new cancellation, so the marker always describes the latest one. */
export const GRAYLUM_INITIATED_CANCEL = 'graylum_initiated';

export type StripeScope = Readonly<{ merchant: string; mode: 'test' | 'live' }>;
export type PurchaseAction = Readonly<{
  itemType: 'credit_package' | 'membership_plan';
  itemId: string;
  billingCycle: 'one_time' | 'monthly' | 'yearly';
}>;

export function centsToMajor(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('PAY_COMMON_AMOUNT_INVALID');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function majorToCents(amount: string): number {
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(amount)) throw new Error('PAY_COMMON_AMOUNT_INVALID');
  const [whole, fraction = ''] = amount.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PAY_COMMON_AMOUNT_INVALID');
  return Number(cents);
}

// Identity is server-owned. This digest identifies a request payload, never a provider object.
export function purchasePayloadHash(action: PurchaseAction): string {
  return createHash('sha256').update([
    action.itemType, action.itemId, action.billingCycle,
  ].join(':')).digest('hex');
}

export function checkoutIdempotencyKey(orderId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    throw new Error('PAY_COMMON_ORDER_INVALID');
  }
  return `pay-common:checkout:${orderId}`;
}

/** Pre-tax amount due: price minus discount. For `exclusive` snapshots (PAY-STRIPE-MP) any tax is added
 * on top by Stripe and never part of this amount; see stripePreTaxAmount for provider totals. */
export function snapshotAmountDue(snapshot: PurchaseSnapshot): number {
  if (snapshot.currency !== 'usd') throw new Error('PAY_COMMON_CURRENCY_OR_TAX_UNSUPPORTED');
  const result = majorToCents(snapshot.price) - majorToCents(snapshot.discount);
  if (result <= 0) throw new Error('PAY_COMMON_AMOUNT_INVALID');
  return result;
}

/** Provider total minus the tax Stripe added. Only an `exclusive` snapshot may carry tax; any other
 * snapshot with tax is a mismatch (the price was not what the order recorded). */
export function stripePreTaxAmount(snapshot: PurchaseSnapshot, total: number | null, tax: number | null | undefined) {
  const added = tax ?? 0;
  if (total === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(added) || added < 0 || added > total
    || (added > 0 && snapshot.tax_behavior !== 'exclusive')) throw new Error('PAY_COMMON_RECEIPT_MISMATCH');
  return total - added;
}

export function assertPurchaseReceipt(input: {
  snapshot: unknown;
  amount: number | null;
  /** Tax Stripe added on top (Checkout/Invoice total_details); omit for amounts that carry no tax. */
  tax?: number | null;
  currency: string | null;
  livemode: boolean;
  scope: StripeScope;
}) {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  if (input.livemode !== (input.scope.mode === 'live') || input.currency !== snapshot.currency
    || stripePreTaxAmount(snapshot, input.amount, input.tax) !== snapshotAmountDue(snapshot)) {
    throw new Error('PAY_COMMON_RECEIPT_MISMATCH');
  }
  return snapshot;
}

export function frozenGrantCredits(snapshot: PurchaseSnapshot): number {
  const total = snapshot.credits + snapshot.bonus_credits;
  if (!Number.isSafeInteger(total) || total <= 0 || total > 2147483647) {
    throw new Error('PAY_COMMON_CREDITS_INVALID');
  }
  return total;
}
