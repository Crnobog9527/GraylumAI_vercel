'use client';

import { memo, useMemo } from 'react';
import { Zap, TrendingDown, Package, RefreshCw, Crown, CheckCircle2, Settings, Loader2 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { formatCreditsBalance } from '@/components/credits/balancePresentation';
import {
  countsAsCreditSpend,
  getCreditLedgerLabel,
  normalizeCreditLedgerType,
  type CreditLedgerType,
} from './creditLedgerPresentation';

interface MockUser {
  email?: string;
  credits?: number;
  total_credits_used?: number;
}

interface Transaction {
  id: string;
  type: string;
  ledger_type?: CreditLedgerType | string | null;
  counts_as_spend?: boolean | null;
  source_type?: string | null;
  idempotency_key?: string | null;
  amount: number;
  balance_after: number | null;
  description?: string;
  created_date: string;
}

// 每日积分消耗趋势图组件（简化版）
const DailyUsageTrendChart = memo(function DailyUsageTrendChart({
  transactions
}: {
  transactions: Transaction[];
}) {
  // 根据真实交易数据生成14天消耗趋势
  const chartData = useMemo(() => {
    const now = new Date();
    const days: { date: string; fullDate: string; usage: number }[] = [];

    // 按日期分组统计消耗
    const usageByDate: Record<string, number> = {};
    transactions.forEach(tx => {
      if (countsAsCreditSpend(tx)) {
        const txDate = new Date(tx.created_date);
        const dateKey = `${txDate.getFullYear()}-${txDate.getMonth() + 1}-${txDate.getDate()}`;
        usageByDate[dateKey] = (usageByDate[dateKey] || 0) + Math.abs(tx.amount);
      }
    });

    for (let i = 13; i >= 0; i--) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const dateStr = `${(day.getMonth() + 1).toString().padStart(2, '0')}/${day.getDate().toString().padStart(2, '0')}`;
      const fullDate = `${day.getMonth() + 1}月${day.getDate()}日`;
      const dateKey = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;

      // 使用真实数据，如果没有则为0
      const usage = usageByDate[dateKey] || 0;

      days.push({ date: dateStr, fullDate, usage });
    }

    return days;
  }, [transactions]);

  // 计算统计数据
  const stats = useMemo(() => {
    const totalUsage = chartData.reduce((sum, d) => sum + d.usage, 0);
    const avgUsage = Math.round(totalUsage / chartData.length);
    const maxUsage = Math.max(...chartData.map(d => d.usage));
    return { totalUsage, avgUsage, maxUsage };
  }, [chartData]);

  return (
    <div
      className="mt-6 rounded-2xl p-6 md:p-8"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
          >
            <TrendingDown className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>每日消耗趋势</h3>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="text-left md:text-right">
            <span style={{ color: 'var(--text-tertiary)' }}>14日总计</span>
            <span className="ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
              {stats.totalUsage.toLocaleString()}
            </span>
          </div>
          <div className="text-left md:text-right hidden md:block">
            <span style={{ color: 'var(--text-tertiary)' }}>日均</span>
            <span className="ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
              {stats.avgUsage.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* 简化的条形图 */}
      <div className="h-[200px] w-full flex items-end justify-between gap-1">
        {chartData.map((day, index) => {
          // 防止除以0导致NaN
          const heightPercent = stats.maxUsage > 0 ? (day.usage / stats.maxUsage) * 100 : 0;
          return (
            <div key={index} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-t transition-opacity duration-200 hover:opacity-80"
                style={{
                  height: `${heightPercent}%`,
                  minHeight: '4px',
                  background: 'linear-gradient(to top, var(--color-primary), var(--color-secondary))',
                  opacity: stats.maxUsage > 0 ? 0.7 + (heightPercent / 100) * 0.3 : 0.7
                }}
                title={`${day.fullDate}: ${day.usage} 积分`}
              />
              <span className="text-[10px] hidden md:block" style={{ color: 'var(--text-disabled)' }}>
                {day.date.split('/')[1]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// 积分记录页面主组件
export const CreditRecordsCard = memo(function CreditRecordsCard({ user }: { user: MockUser }) {
  const credits = typeof user?.credits === 'number' ? user.credits : null;

  // 从 API 获取积分统计数据
  const { data: creditsSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'month' });
  const { data: allTimeSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'all' });
  const monthlyUsed = creditsSummary?.totalSpent ?? 0;
  const totalUsed = allTimeSummary?.totalSpent ?? user?.total_credits_used ?? 0;

  // 从 API 获取交易记录
  const { data: transactionsData, isLoading: isLoadingTx } = trpc.credits.getCreditTransactions.useQuery({ limit: 50 });

  // 转换 API 数据为组件所需格式
  const transactions: Transaction[] = useMemo(() => {
    if (!transactionsData?.items) return [];
    return transactionsData.items.map((tx: any) => ({
      id: tx.id,
      type: tx.type,
      ledger_type: tx.ledger_type ?? null,
      counts_as_spend: tx.counts_as_spend ?? null,
      source_type: tx.source_type ?? null,
      idempotency_key: tx.idempotency_key ?? null,
      amount: tx.amount,
      balance_after: tx.balance_after ?? null,
      description: tx.reason ?? tx.description ?? '',
      created_date: tx.created_at,
    }));
  }, [transactionsData]);

  const typeLabels: Record<string, string> = {
    addition: '积分增加',
    deduction: '积分消耗',
    purchase: '购买积分',
    usage: '积分消耗',
    consumption: '积分消耗',
    bonus: '积分奖励',
    refund: '积分退款',
    admin_adjustment: '管理员调整',
    adjustment: '系统调整',
    membership: '会员权益',
    checkin: '签到奖励',
    transfer_in: '积分转入',
    transfer_out: '积分转出',
    expiration: '积分过期',
    grant: '积分到账',
    spend: 'AI 使用消耗',
    refund_clawback: '退款扣回',
  };

  const typeIcons: Record<string, { icon: typeof Package; color: string }> = {
    addition: { icon: Crown, color: 'var(--success)' },
    deduction: { icon: Zap, color: 'var(--color-primary)' },
    purchase: { icon: Package, color: 'var(--success)' },
    usage: { icon: Zap, color: 'var(--color-primary)' },
    consumption: { icon: Zap, color: 'var(--color-primary)' },
    bonus: { icon: Crown, color: 'var(--color-secondary)' },
    refund: { icon: RefreshCw, color: 'rgba(139, 92, 246, 1)' },
    admin_adjustment: { icon: Settings, color: 'var(--text-tertiary)' },
    adjustment: { icon: Settings, color: 'var(--text-tertiary)' },
    membership: { icon: Crown, color: 'var(--color-primary)' },
    checkin: { icon: CheckCircle2, color: 'var(--success)' },
    transfer_in: { icon: Package, color: 'var(--success)' },
    transfer_out: { icon: Package, color: 'var(--error)' },
    expiration: { icon: Zap, color: 'var(--text-disabled)' },
    grant: { icon: Crown, color: 'var(--success)' },
    spend: { icon: Zap, color: 'var(--color-primary)' },
    refund_clawback: { icon: RefreshCw, color: 'rgba(245, 158, 11, 1)' },
  };

  return (
    <>
      {/* 积分概览 */}
      <div
        className="mb-6 rounded-2xl p-6 md:p-8"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>积分概览</h3>
          <Zap className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8">
            <div>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>积分余额</div>
              <div
                className="text-3xl font-bold"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}
              >
                {formatCreditsBalance(credits === null ? 'unavailable' : 'ready', credits)}
              </div>
            </div>

            <div
              className="rounded-xl p-4 md:rounded-none md:p-0 md:pl-8"
              style={{
                borderLeft: '1px solid transparent',
                background: 'var(--bg-primary)',
              }}
            >
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>本月消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{monthlyUsed.toLocaleString()}</div>
            </div>

            <div
              className="rounded-xl p-4 md:rounded-none md:p-0 md:pl-8"
              style={{
                borderLeft: '1px solid transparent',
                background: 'var(--bg-primary)',
              }}
            >
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>累计消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{totalUsed.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 每日消耗趋势图 */}
      <DailyUsageTrendChart transactions={transactions} />

      {/* 交易记录列表 */}
      <div
        className="rounded-2xl p-6 mt-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>交易记录</h3>
        </div>

        {isLoadingTx ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
            暂无交易记录
          </div>
        ) : (
        <div className="space-y-4">
          {transactions.map((tx) => {
            const ledgerType = normalizeCreditLedgerType(tx);
            const typeConfig = typeIcons[ledgerType] || typeIcons[tx.type] || typeIcons.deduction;
            const Icon = typeConfig.icon;
            const txDate = new Date(tx.created_date);

            return (
              <div
                key={tx.id}
                className="flex flex-col justify-between rounded-xl border p-4 md:flex-row md:items-center"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-primary)'
                }}
              >
                <div className="flex items-start gap-4 mb-4 md:mb-0">
                  <div
                    className="p-3 rounded-xl"
                    style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
                  >
                    <Icon className="h-5 w-5" style={{ color: typeConfig.color }} />
                  </div>
                  <div>
                    <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                      {typeLabels[ledgerType] || getCreditLedgerLabel(tx)}
                    </div>
                    <div className="text-xs max-w-md truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {tx.description || '-'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-1 md:justify-end items-center gap-4 md:gap-8">
                  <div className="text-right">
                  <div
                      className="font-bold"
                      style={{ color: tx.amount > 0 ? 'var(--success)' : 'var(--error)' }}
                    >
                      {tx.amount > 0 ? '+' : ''}{tx.amount} 积分
                    </div>
                    {typeof tx.balance_after === 'number' && (
                      <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>余额：{tx.balance_after}</div>
                    )}
                  </div>

                  <div className="text-right min-w-[100px]">
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {txDate.getFullYear()}-{String(txDate.getMonth() + 1).padStart(2, '0')}-{String(txDate.getDate()).padStart(2, '0')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      {String(txDate.getHours()).padStart(2, '0')}:{String(txDate.getMinutes()).padStart(2, '0')}:{String(txDate.getSeconds()).padStart(2, '0')}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        )}

        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mt-8 pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>共 {transactions.length} 条记录</span>
        </div>
      </div>
    </>
  );
});
