/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Credit packs are for paying members only (MASTER_PLAN §2.1 item 50; subscription and WeChat
 * one-time members count alike). Membership is the server's `user.getEntitlements` level, which
 * is already `free` for a lapsed or refunded member. The button is a convenience: checkout itself
 * refuses non-members on the server (#750), and that refusal is shown with the texts below.
 */
export type PackEntitlement = { status: 'loading' } | { status: 'error' } | { status: 'ready'; level: string | null | undefined };

export const PACK_MEMBERS_ONLY_NOTICE = '积分包只对付费会员（Pro、Gold）开放，开通会员后就能购买，会员购买有折扣。';

export function isPaidMember(entitlement: PackEntitlement) {
  return entitlement.status === 'ready' && (entitlement.level === 'pro' || entitlement.level === 'gold');
}

export function creditPackBuyState(input: {
  price: number; checkoutReady: boolean | undefined; pending: boolean; entitlement: PackEntitlement;
}): { disabled: boolean; label: string } {
  if (input.pending) return { disabled: true, label: '跳转中...' };
  // The store itself cannot sell this pack: same answer for everyone.
  if (!input.checkoutReady || !Number.isFinite(input.price) || input.price <= 0) return { disabled: true, label: '暂不可购买' };
  if (input.entitlement.status === 'loading') return { disabled: true, label: '正在确认会员状态' };
  if (input.entitlement.status === 'error') return { disabled: true, label: '暂时无法确认会员状态' };
  if (!isPaidMember(input.entitlement)) return { disabled: true, label: '开通会员后可购买' };
  return { disabled: false, label: '购买' };
}

const PACK_CHECKOUT_REFUSALS: Record<string, string> = {
  PAYWALL_MEMBERSHIP_REQUIRED: '积分包只对付费会员开放。你当前不是有效会员，开通会员后就能购买。',
  PAYWALL_MEMBERSHIP_UNAVAILABLE: '暂时无法确认会员状态，这次没有发起购买，请稍后再试。',
};

/** Plain text for the server's credit-pack refusal codes; null for anything else. */
export function packCheckoutRefusal(error: unknown): string | null {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return PACK_CHECKOUT_REFUSALS[message] ?? null;
}
