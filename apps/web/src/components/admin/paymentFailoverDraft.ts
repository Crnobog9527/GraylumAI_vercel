/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type PaymentChannel = 'stripe' | 'waffo';
export type PaymentChannelSetting = { channel: PaymentChannel; version: number };
export const PAYMENT_CHANNEL_OPTIONS: ReadonlyArray<{ channel: PaymentChannel; label: string; note: string }> = [
  { channel: 'stripe', label: 'Stripe', note: '默认主渠道' },
  { channel: 'waffo', label: 'Waffo', note: '应急：一次性付款' },
];

/** The absence of the new field is the migration-compatible Stripe default. Invalid reads never become defaults. */
export function readPaymentChannelSetting(value: unknown): PaymentChannelSetting | null {
  if (!value || typeof value !== 'object') return null;
  const { newPurchaseChannel, version, card } = value as {
    newPurchaseChannel?: unknown; version?: unknown; card?: { enabled?: unknown };
  };
  if (newPurchaseChannel !== undefined && newPurchaseChannel !== 'stripe' && newPurchaseChannel !== 'waffo') return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof card?.enabled !== 'boolean') return null;
  return { channel: newPurchaseChannel ?? 'stripe', version };
}

/** A version claim is never silently upgraded after a conflict. */
export function buildPaymentChannelSave(current: PaymentChannelSetting, channel: PaymentChannel) {
  return { expectedVersion: current.version, channel };
}

// Reuse the existing unknown-result handling; the legacy setting key is never exported here.
export { PAYMENT_CHANNEL_SAVE_ERROR_TEXT, classifyPaymentChannelSaveError } from './paymentChannelDraft';
export type { SaveErrorKind } from './paymentChannelDraft';
