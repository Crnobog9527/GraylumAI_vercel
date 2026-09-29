/**
 * 积分余额 hook 和余额预警工具
 */

import { trpc } from '@/trpc/client';
import { useCallback } from 'react';

// ============================================================================
// 余额预警阈值配置
// ============================================================================

export const CREDIT_THRESHOLDS = {
  LOW: 100,      // < 100 积分: 黄色警告
  VERY_LOW: 50,  // < 50 积分: 橙色警告 + Toast
  CRITICAL: 10,  // < 10 积分: 红色警告 + 弹窗
  EMPTY: 0,      // 0 积分: 阻止发送
} as const;

export type WarningLevel = 'none' | 'low' | 'very_low' | 'critical' | 'empty';
export type CreditsBalanceStatus = 'loading' | 'ready' | 'unavailable';

export interface CreditsBalanceState {
  status: CreditsBalanceStatus;
  credits: number | null;
  creditsExpiringSoon: number | null;
  creditsExpiryDate: string | null;
  warningLevel: WarningLevel | null;
}

function isValidCredits(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0;
}

export function deriveCreditsBalanceState(input: {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
}): CreditsBalanceState {
  if (input.error) {
    return {
      status: 'unavailable',
      credits: null,
      creditsExpiringSoon: null,
      creditsExpiryDate: null,
      warningLevel: null,
    };
  }

  const data = input.data && typeof input.data === 'object'
    ? input.data as Record<string, unknown>
    : null;
  if (data && isValidCredits(data.credits)) {
    return {
      status: 'ready',
      credits: data.credits,
      creditsExpiringSoon: isValidCredits(data.creditsExpiringSoon) ? data.creditsExpiringSoon : 0,
      creditsExpiryDate: typeof data.creditsExpiryDate === 'string' ? data.creditsExpiryDate : null,
      warningLevel: getWarningLevel(data.credits),
    };
  }

  if (input.isLoading) {
    return {
      status: 'loading',
      credits: null,
      creditsExpiringSoon: null,
      creditsExpiryDate: null,
      warningLevel: null,
    };
  }

  return {
    status: 'unavailable',
    credits: null,
    creditsExpiringSoon: null,
    creditsExpiryDate: null,
    warningLevel: null,
  };
}

/**
 * 根据积分余额判断警告级别
 */
export function getWarningLevel(credits: number): WarningLevel {
  if (credits <= CREDIT_THRESHOLDS.EMPTY) return 'empty';
  if (credits < CREDIT_THRESHOLDS.CRITICAL) return 'critical';
  if (credits < CREDIT_THRESHOLDS.VERY_LOW) return 'very_low';
  if (credits < CREDIT_THRESHOLDS.LOW) return 'low';
  return 'none';
}

/**
 * 获取警告级别对应的颜色
 */
export function getWarningColor(level: WarningLevel): string {
  switch (level) {
    case 'empty':
    case 'critical':
      return 'var(--error)'; // 红色
    case 'very_low':
      return '#f97316'; // 橙色
    case 'low':
      return '#eab308'; // 黄色
    default:
      return 'var(--color-primary)'; // 金色 (正常)
  }
}

/**
 * 获取警告级别对应的背景色
 */
export function getWarningBgColor(level: WarningLevel): string {
  switch (level) {
    case 'empty':
    case 'critical':
      return 'rgba(239, 68, 68, 0.1)'; // 红色背景
    case 'very_low':
      return 'rgba(249, 115, 22, 0.1)'; // 橙色背景
    case 'low':
      return 'rgba(234, 179, 8, 0.1)'; // 黄色背景
    default:
      return 'var(--color-primary-10)'; // 金色背景 (正常)
  }
}

/**
 * 获取警告级别对应的边框色
 */
export function getWarningBorderColor(level: WarningLevel): string {
  switch (level) {
    case 'empty':
    case 'critical':
      return 'rgba(239, 68, 68, 0.2)';
    case 'very_low':
      return 'rgba(249, 115, 22, 0.2)';
    case 'low':
      return 'rgba(234, 179, 8, 0.2)';
    default:
      return 'var(--color-primary-20)';
  }
}

/**
 * 获取积分余额
 */
export function useCreditsBalance(options?: { enabled?: boolean }) {
  const query = trpc.credits.getBalance.useQuery(undefined, {
    enabled: options?.enabled ?? true,
    staleTime: 30 * 1000, // 30秒内不重新请求
    refetchOnWindowFocus: true, // 窗口聚焦时刷新
  });

  const balanceState = deriveCreditsBalanceState({
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
  });
  const refreshBalance = useCallback(async (): Promise<CreditsBalanceState> => {
    try {
      const result = await query.refetch();
      return deriveCreditsBalanceState({
        data: result.data,
        error: result.error,
        isLoading: false,
      });
    } catch (error) {
      return deriveCreditsBalanceState({ error, isLoading: false });
    }
  }, [query.refetch]);
  const isReady = balanceState.status === 'ready';
  const warningLevel = balanceState.warningLevel;

  return {
    ...balanceState,
    isLoading: balanceState.status === 'loading',
    isUnavailable: balanceState.status === 'unavailable',
    error: query.error,
    refetch: refreshBalance,
    // 预警相关
    warningColor: warningLevel ? getWarningColor(warningLevel) : 'var(--text-tertiary)',
    warningBgColor: warningLevel ? getWarningBgColor(warningLevel) : 'var(--bg-secondary)',
    warningBorderColor: warningLevel ? getWarningBorderColor(warningLevel) : 'var(--border-primary)',
    isLowBalance: isReady && warningLevel !== 'none',
    canSendMessage: isReady
      && balanceState.credits !== null
      && balanceState.credits > CREDIT_THRESHOLDS.EMPTY,
  };
}
