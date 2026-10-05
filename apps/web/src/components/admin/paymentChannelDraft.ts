/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

export const PAYMENT_CHANNEL_SETTING_KEY = 'payment_new_purchase_channel';
export type PaymentChannel = 'waffo' | 'stripe';
export type PaymentChannelSetting = { channel: PaymentChannel; version: number };

export const PAYMENT_CHANNEL_OPTIONS: ReadonlyArray<{ channel: PaymentChannel; label: string; note: string }> = [
  { channel: 'stripe', label: 'Stripe', note: '已接入' },
  { channel: 'waffo', label: 'Waffo', note: '未接入：选它会暂停所有新购买' },
];

/** Accepts only a well-formed server read; anything else is treated as a read failure. */
export function readPaymentChannelSetting(value: unknown): PaymentChannelSetting | null {
  if (!value || typeof value !== 'object') return null;
  const { channel, version } = value as { channel?: unknown; version?: unknown };
  if (channel !== 'stripe' && channel !== 'waffo') return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return null;
  return { channel, version };
}

/** The save always claims the next version of what was read; the server rejects a stale claim. */
export function buildPaymentChannelSave(current: PaymentChannelSetting, channel: PaymentChannel) {
  return { key: PAYMENT_CHANNEL_SETTING_KEY, value: { channel, version: current.version + 1 } };
}

export type SaveErrorKind = 'conflict' | 'rejected' | 'failed';

export function classifyPaymentChannelSaveError(error: { data?: { code?: string } | null } | null | undefined): SaveErrorKind {
  const code = error?.data?.code;
  if (code === 'CONFLICT') return 'conflict';
  if (code === 'BAD_REQUEST') return 'rejected';
  return 'failed';
}

export const PAYMENT_CHANNEL_SAVE_ERROR_TEXT: Record<SaveErrorKind, string> = {
  conflict: '这个设置刚被其他人改过，你这次没有保存成功。请先点“重新读取”看最新的选择，再决定是否重新保存。',
  rejected: '服务端拒绝了这次保存，设置没有改变。请点“重新读取”后再试。',
  // A lost response may hide a committed save, so the outcome is unknown until the authoritative value is reread.
  failed: '没能确认这次保存是否生效。请先点“重新读取”查看当前实际设置，再决定是否重新保存。',
};

type CatalogPackage = { checkout_ready?: boolean | null };
type CatalogPlan = { level?: string | null; checkoutReady?: { monthly?: boolean | null; yearly?: boolean | null } | null };

export type PurchaseReadiness =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; packagesReady: number; packagesTotal: number; plansReady: number; plansTotal: number };

/**
 * Actual purchase readiness from the public catalog, shown apart from the saved selection:
 * a saved Stripe choice can still have nothing purchasable (no test price, Stripe not configured).
 */
export function summarizePurchaseReadiness(input: {
  packages: readonly CatalogPackage[] | undefined;
  plans: readonly CatalogPlan[] | undefined;
  loading: boolean;
  failed: boolean;
}): PurchaseReadiness {
  if (input.failed) return { state: 'error' };
  if (input.loading || !input.packages || !input.plans) return { state: 'loading' };
  const paidPlans = input.plans.filter(plan => plan.level !== 'free');
  return {
    state: 'ready',
    packagesReady: input.packages.filter(pkg => pkg.checkout_ready === true).length,
    packagesTotal: input.packages.length,
    // A paid plan counts as purchasable when at least one billing cycle can be bought.
    plansReady: paidPlans.filter(plan => plan.checkoutReady?.monthly === true || plan.checkoutReady?.yearly === true).length,
    plansTotal: paidPlans.length,
  };
}
