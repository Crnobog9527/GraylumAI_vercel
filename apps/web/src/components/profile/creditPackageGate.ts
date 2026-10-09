/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Credit packs are for paying members only (MASTER_PLAN §2.1 item 50; subscription and WeChat
 * one-time members count alike). Membership is the server's `user.getEntitlements` level, which
 * is already `free` for a lapsed or refunded member. This is display only: the server-side refusal
 * for non-members is a separate backend task, so the button must never be the only guard.
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
