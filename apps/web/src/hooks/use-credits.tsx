/**
 * 积分系统前端使用示例
 * 
 * 展示如何在 React 应用中使用 tRPC 积分 API
 */

import { trpc } from '@/trpc/client';
import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 自定义 Hooks
// ============================================================================

/**
 * 获取积分余额
 */
export function useCreditsBalance() {
  const query = trpc.credits.getBalance.useQuery(undefined, {
    staleTime: 30 * 1000, // 30秒内不重新请求
    refetchOnWindowFocus: true, // 窗口聚焦时刷新
  });

  return {
    credits: query.data?.credits ?? 0,
    creditsExpiringSoon: query.data?.creditsExpiringSoon ?? 0,
    creditsExpiryDate: query.data?.creditsExpiryDate,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
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

  return {
    sufficient: query.data?.sufficient ?? false,
    currentCredits: query.data?.currentCredits ?? 0,
    shortfall: query.data?.shortfall ?? 0,
    isLoading: query.isLoading,
  };
}

// ============================================================================
// 使用示例组件
// ============================================================================

/**
 * 积分显示组件
 */
export function CreditsDisplay() {
  const { credits, creditsExpiringSoon, isLoading, error } = useCreditsBalance();

  if (isLoading) return <div>加载中...</div>;
  if (error) return <div>获取积分失败</div>;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xl font-bold">{credits} 积分</div>
      {creditsExpiringSoon > 0 && (
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
  const { sufficient, shortfall } = useCheckCredits(amount);

  const handleConsume = async () => {
    if (!sufficient) {
      alert(`积分不足，还差 ${shortfall} 积分`);
      return;
    }

    try {
      const result = await deduct(amount, {
        reason: '服务消费',
        referenceId: serviceId,
        referenceType: 'service',
      });
      
      console.log('扣除成功:', result);
      alert(`成功消费 ${amount} 积分`);
    } catch (err) {
      console.error('扣除失败:', err);
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
