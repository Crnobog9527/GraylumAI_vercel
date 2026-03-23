export const STRIPE_MANAGED_ACTIVE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
] as const;

export function isStripeManagedSubscriptionActive(input: {
  stripeSubscriptionId?: string | null;
  status?: string | null;
}) {
  if (!input.stripeSubscriptionId) {
    return false;
  }

  const normalizedStatus = input.status?.toLowerCase() ?? '';
  return STRIPE_MANAGED_ACTIVE_SUBSCRIPTION_STATUSES.includes(
    normalizedStatus as (typeof STRIPE_MANAGED_ACTIVE_SUBSCRIPTION_STATUSES)[number]
  );
}

export function getAdminMembershipOverrideErrorMessage() {
  return '该用户存在有效的 Stripe 订阅，禁止在后台直接修改会员等级。请先通过订阅侧调整或取消后再处理。';
}
