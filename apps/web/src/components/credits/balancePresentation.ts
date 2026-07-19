import type { CreditsBalanceStatus } from '@/hooks/use-credits';

export function formatCreditsBalance(status: CreditsBalanceStatus, credits: number | null): string {
  return status === 'ready' && credits !== null ? credits.toLocaleString() : '--';
}

export function getCreditsAvailabilityLabel(status: CreditsBalanceStatus): string | null {
  return status === 'unavailable' ? '暂不可用' : null;
}

export type CreditsRechargeAction =
  | { available: true; href: '/profile?tab=subscription' }
  | { available: false; href: null };

export function getCreditsRechargeAction(status: CreditsBalanceStatus): CreditsRechargeAction {
  return status === 'ready'
    ? { available: true, href: '/profile?tab=subscription' }
    : { available: false, href: null };
}
