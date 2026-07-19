/**
 * 积分系统前端使用示例
 * 
 * 展示如何在 React 应用中使用 tRPC 积分 API
 */

import { trpc } from '@/trpc/client';
import { logClientDevError } from '@/lib/client-log';
import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 自定义 Hooks
// ============================================================================

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

/**
 * 扣除积分
 */
export function useDeductCredits() {
  const utils = trpc.useUtils();
  
  const mutation = trpc.credits.deductCredits.useMutation({
    onSuccess: () => {
      // 成功后刷新余额
      utils.credits.getBalance.invalidate();
      utils.credits.getCreditTransactions.invalidate();
    },
  });

  const deduct = async (
    amount: number,
    options?: {
      reason?: string;
      referenceId?: string;
      referenceType?: string;
    }
  ) => {
    // 生成幂等键，防止重复扣除
    const idempotencyKey = uuidv4();
    
    return mutation.mutateAsync({
      amount,
      reason: options?.reason,
      referenceId: options?.referenceId,
      referenceType: options?.referenceType,
      idempotencyKey,
    });
  };

  return {
    deduct,
    isLoading: mutation.isPending,
    error: mutation.error,
    data: mutation.data,
    reset: mutation.reset,
  };
}

/**
 * 添加积分
 */
export function useAddCredits() {
  const utils = trpc.useUtils();
  
  const mutation = trpc.credits.addCredits.useMutation({
    onSuccess: () => {
      utils.credits.getBalance.invalidate();
      utils.credits.getCreditTransactions.invalidate();
    },
  });

  const add = async (
    amount: number,
    options?: {
      type?: 'purchase' | 'bonus' | 'refund';
      reason?: string;
      referenceId?: string;
    }
  ) => {
    const idempotencyKey = uuidv4();
    
    return mutation.mutateAsync({
      amount,
      type: options?.type ?? 'bonus',
      reason: options?.reason,
      referenceId: options?.referenceId,
      idempotencyKey,
    });
  };

  return {
    add,
    isLoading: mutation.isPending,
    error: mutation.error,
    data: mutation.data,
  };
}

/**
 * 获取交易记录（分页）
 */
export function useCreditTransactions(options?: {
  type?: string;
  limit?: number;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  
  const query = trpc.credits.getCreditTransactions.useQuery({
    limit: options?.limit ?? 20,
    cursor,
    type: options?.type as any,
  });

  return {
    transactions: query.data?.items ?? [],
    hasNextPage: query.data?.hasNextPage ?? false,
    totalCount: query.data?.totalCount ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    loadMore: () => {
      if (query.data?.nextCursor) {
        setCursor(query.data.nextCursor);
      }
    },
    reset: () => setCursor(undefined),
  };
}

/**
 * 检查积分是否足够
 */
export function useCheckCredits(amount: number) {
  const query = trpc.credits.checkSufficientCredits.useQuery(
    { amount },
    { enabled: amount > 0 }
  );

  const status: CreditsBalanceStatus = query.error
    ? 'unavailable'
    : query.data
      ? 'ready'
      : query.isLoading
        ? 'loading'
        : 'unavailable';

  return {
    status,
    sufficient: status === 'ready' ? query.data?.sufficient ?? null : null,
    currentCredits: status === 'ready' ? query.data?.currentCredits ?? null : null,
    shortfall: status === 'ready' ? query.data?.shortfall ?? null : null,
    isLoading: status === 'loading',
  };
}

// ============================================================================
// 使用示例组件
// ============================================================================

/**
 * 积分显示组件
 */
export function CreditsDisplay() {
  const { credits, creditsExpiringSoon, status } = useCreditsBalance();

  if (status === 'loading') return <div>加载中...</div>;
  if (status === 'unavailable' || credits === null) return <div>积分暂不可用</div>;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xl font-bold">{credits} 积分</div>
      {creditsExpiringSoon !== null && creditsExpiringSoon > 0 && (
        <div className="text-sm text-orange-500">
          {creditsExpiringSoon} 积分即将过期
        </div>
      )}
    </div>
  );
}

/**
 * 积分消费按钮
 */
export function ConsumeCreditsButton({ 
  amount, 
  serviceId 
}: { 
  amount: number; 
  serviceId: string;
}) {
  const { deduct, isLoading, error } = useDeductCredits();
  const { status: balanceStatus, sufficient, shortfall } = useCheckCredits(amount);

  const handleConsume = async () => {
    if (balanceStatus !== 'ready') {
      alert('余额暂时无法验证，请重试');
      return;
    }
    if (!sufficient) {
      alert(`积分不足，还差 ${shortfall} 积分`);
      return;
    }

    try {
      await deduct(amount, {
        reason: '服务消费',
        referenceId: serviceId,
        referenceType: 'service',
      });
      alert(`成功消费 ${amount} 积分`);
    } catch {
      logClientDevError('扣除失败');
      alert('积分扣除失败，请重试');
    }
  };

  return (
    <button
      onClick={handleConsume}
      disabled={isLoading || !sufficient}
      className={`
        px-4 py-2 rounded-lg font-medium
        ${sufficient 
          ? 'bg-blue-500 text-white hover:bg-blue-600' 
          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
        }
        ${isLoading ? 'opacity-50' : ''}
      `}
    >
      {isLoading ? '处理中...' : `消费 ${amount} 积分`}
    </button>
  );
}

/**
 * 交易记录列表
 */
export function TransactionList() {
  const { 
    transactions, 
    hasNextPage, 
    isLoading, 
    loadMore,
    totalCount 
  } = useCreditTransactions({ limit: 10 });

  const formatType = (type: string) => {
    const types: Record<string, string> = {
      purchase: '购买',
      consumption: '消费',
      refund: '退款',
      bonus: '奖励',
      adjustment: '调整',
    };
    return types[type] || type;
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-bold">交易记录 ({totalCount})</h3>
      
      <div className="space-y-2">
        {transactions.map((txn) => (
          <div 
            key={txn.id}
            className="flex justify-between items-center p-3 bg-gray-50 rounded"
          >
            <div>
              <span className="font-medium">{formatType(txn.type)}</span>
              <span className="text-sm text-gray-500 ml-2">
                {new Date(txn.created_at).toLocaleString()}
              </span>
            </div>
            <span className={txn.amount > 0 ? 'text-green-500' : 'text-red-500'}>
              {txn.amount > 0 ? '+' : ''}{txn.amount}
            </span>
          </div>
        ))}
      </div>

      {hasNextPage && (
        <button
          onClick={loadMore}
          disabled={isLoading}
          className="text-blue-500 hover:underline"
        >
          {isLoading ? '加载中...' : '加载更多'}
        </button>
      )}
    </div>
  );
}

/**
 * 完整的积分管理页面示例
 */
export function CreditsPage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-3xl font-bold">我的积分</h1>
      
      {/* 积分余额 */}
      <section className="p-6 bg-white rounded-lg shadow">
        <CreditsDisplay />
      </section>
      
      {/* 消费测试 */}
      <section className="p-6 bg-white rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">消费测试</h2>
        <div className="flex gap-4">
          <ConsumeCreditsButton amount={10} serviceId="test-service-1" />
          <ConsumeCreditsButton amount={50} serviceId="test-service-2" />
          <ConsumeCreditsButton amount={100} serviceId="test-service-3" />
        </div>
      </section>
      
      {/* 交易记录 */}
      <section className="p-6 bg-white rounded-lg shadow">
        <TransactionList />
      </section>
    </div>
  );
}
