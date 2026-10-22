/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { MembershipBillingCycle, MembershipEligibilityResult, MembershipLevel } from './membershipEligibility';

type InternalSubscription = {
  payment_method?: string | null;
  purchase_mode?: string | null;
  id?: string | null;
  payment_channel?: string | null;
  mapping_state?: string | null;
  membership_level?: string | null;
  billing_cycle?: string | null;
  current_period_end?: string | null;
  /** Set by 0214 only inside the 24-hour card renewal grace; the paid end stays in current_period_end. */
  renewal_grace_until?: string | null;
  cancel_at_period_end?: string | boolean | null;
};

// This is the existing facts RPC's paid-order projection, never a client-supplied grant.
export function internalMembershipState(subscription: InternalSubscription | null) {
  const mapping = subscription?.mapping_state;
  if (mapping !== 'internal_paid' && mapping !== 'internal_inactive') return null;
  const level = subscription?.membership_level;
  const end = Math.max(Date.parse(subscription?.current_period_end ?? ''), Date.parse(subscription?.renewal_grace_until ?? '') || -Infinity);
  const active = mapping === 'internal_paid' && (level === 'pro' || level === 'gold')
    && Number.isFinite(end) && end > Date.now();
  const oneTime = subscription?.payment_channel === 'waffo' && subscription.purchase_mode === 'payment'
    || subscription?.payment_channel === 'stripe' && ['wechat_pay', 'alipay'].includes(subscription?.payment_method ?? '');
  return {
    state: active ? (!oneTime && (subscription?.cancel_at_period_end === true || subscription?.cancel_at_period_end === 'true')
      ? 'cancel_at_period_end' as const : 'active' as const) : 'free' as const,
    level: (active ? level : 'free') as MembershipLevel,
    billingCycle: subscription?.billing_cycle === 'monthly' || subscription?.billing_cycle === 'yearly'
      ? subscription.billing_cycle as MembershipBillingCycle : null,
    source: 'internal_membership' as MembershipEligibilityResult['source'],
  };
}
