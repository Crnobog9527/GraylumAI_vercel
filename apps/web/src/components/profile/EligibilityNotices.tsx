/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE } from './subscriptionPlanButtonState';

/**
 * Account-wide reasons the plan buttons are disabled, shown once above the plans on the subscription page
 * (a disabled button never runs its click handler, so its message would otherwise stay hidden).
 */
export function EligibilityNotices({ entries }: { entries?: ReadonlyArray<{ reasonCode: string; action: string }> }) {
  const restore = entries?.some(entry => entry.reasonCode === 'RENEWAL_RESTORE_REQUIRED');
  const unpaid = entries?.some(entry => entry.action === 'resolvePaymentIssue');
  return <>
    {restore && <p className="mb-4 text-sm">
      已安排到期取消，当前权益保留至到期。请先通过“管理订阅 / 取消续费”恢复续费后再升级套餐。</p>}
    {unpaid && <p className="mb-4 text-sm" role="status" data-testid="profile-unpaid-subscription-notice"
      style={{ color: 'var(--warning)' }}>{UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE}</p>}
  </>;
}
