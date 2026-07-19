import type { CreditsBalanceStatus } from '@/hooks/use-credits';

export function formatCreditsBalance(status: CreditsBalanceStatus, credits: number | null): string {
  return status === 'ready' && credits !== null ? credits.toLocaleString() : '--';
}

export function getCreditsAvailabilityLabel(status: CreditsBalanceStatus): string | null {
  return status === 'unavailable' ? '暂不可用' : null;
}
