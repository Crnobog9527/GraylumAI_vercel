/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { freezePurchaseSnapshot, type PurchaseSnapshot } from './contracts';

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

export function snapshotAmountDue(snapshot: PurchaseSnapshot): number {
  if (snapshot.currency !== 'usd' || snapshot.tax_behavior === 'exclusive') {
    throw new Error('PAY_COMMON_CURRENCY_OR_TAX_UNSUPPORTED');
  }
  const result = majorToCents(snapshot.price) - majorToCents(snapshot.discount);
  if (result <= 0) throw new Error('PAY_COMMON_AMOUNT_INVALID');
  return result;
}

export function assertPurchaseReceipt(input: {
  snapshot: unknown;
  amount: number | null;
  currency: string | null;
  livemode: boolean;
  scope: StripeScope;
}) {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  if (input.livemode !== (input.scope.mode === 'live') || input.currency !== snapshot.currency
    || input.amount !== snapshotAmountDue(snapshot)) {
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
