import type { CreditsBalanceState, WarningLevel } from '@/hooks/use-credits';

export const CHAT_BALANCE_UNAVAILABLE_PRESENTATION = {
  title: '余额暂时无法验证',
  description: '余额暂时无法验证，请重试。您的输入已保留，本次不会发送 AI 请求。',
  retryLabel: '重试',
  cancelLabel: '稍后再试',
} as const;

export type ChatBalancePreflightDecision =
  | { status: 'unavailable' }
  | { status: 'blocked_zero'; credits: 0; warningLevel: 'empty' }
  | { status: 'ready'; credits: number; warningLevel: WarningLevel };

export async function runChatBalancePreflight(options: {
  cachedCredits: number | null;
  refetchBalance: () => Promise<CreditsBalanceState>;
  resolveFreeTierEnabled: () => Promise<boolean>;
  onReady: (balance: { credits: number; warningLevel: WarningLevel }) => Promise<void>;
}): Promise<ChatBalancePreflightDecision> {
  // cachedCredits is display-only. Authorization always depends on this refetch.
  let freshBalance: CreditsBalanceState;
  try {
    freshBalance = await options.refetchBalance();
  } catch {
    return { status: 'unavailable' };
  }

  if (
    freshBalance.status !== 'ready'
    || freshBalance.credits === null
    || freshBalance.warningLevel === null
  ) {
    return { status: 'unavailable' };
  }

  const readyBalance = {
    credits: freshBalance.credits,
    warningLevel: freshBalance.warningLevel,
  };
  if (freshBalance.credits > 0) {
    await options.onReady(readyBalance);
    return { status: 'ready', ...readyBalance };
  }

  let freeTierEnabled: boolean;
  try {
    freeTierEnabled = await options.resolveFreeTierEnabled();
  } catch {
    return { status: 'unavailable' };
  }
  if (freshBalance.credits === 0 && !freeTierEnabled) {
    return {
      status: 'blocked_zero',
      credits: 0,
      warningLevel: 'empty',
    };
  }

  await options.onReady(readyBalance);
  return { status: 'ready', ...readyBalance };
}
