'use client';

import { memo, useMemo } from 'react';
import { Zap, TrendingDown, Package, RefreshCw, Crown, CheckCircle2, Settings } from 'lucide-react';

interface MockUser {
  email?: string;
  credits?: number;
  total_credits_used?: number;
}

interface Transaction {
  id: string;
  type: 'usage' | 'purchase' | 'bonus' | 'refund' | 'admin_adjustment' | 'membership' | 'checkin';
  amount: number;
  balance_after: number;
  description?: string;
  created_date: string;
}

// 每日积分消耗趋势图组件（简化版）
const DailyUsageTrendChart = memo(function DailyUsageTrendChart({
  transactions
}: {
  transactions: Transaction[];
}) {
  // 生成模拟的14天数据
  const chartData = useMemo(() => {
    const now = new Date();
    const days: { date: string; fullDate: string; usage: number }[] = [];

    for (let i = 13; i >= 0; i--) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const dateStr = `${(day.getMonth() + 1).toString().padStart(2, '0')}/${day.getDate().toString().padStart(2, '0')}`;
      const fullDate = `${day.getMonth() + 1}月${day.getDate()}日`;

      // 生成随机使用量进行演示
      const usage = Math.floor(Math.random() * 100) + 10;

      days.push({ date: dateStr, fullDate, usage });
    }

    return days;
  }, []);

  // 计算统计数据
  const stats = useMemo(() => {
    const totalUsage = chartData.reduce((sum, d) => sum + d.usage, 0);
    const avgUsage = Math.round(totalUsage / chartData.length);
    const maxUsage = Math.max(...chartData.map(d => d.usage));
    return { totalUsage, avgUsage, maxUsage };
  }, [chartData]);

  return (
    <div
      className="rounded-2xl p-6 md:p-8 mt-6 transition-all duration-300"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex items-center justify-between mb-6">
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
          <div className="text-right">
            <span style={{ color: 'var(--text-tertiary)' }}>14日总计</span>
            <span className="ml-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
              {stats.totalUsage.toLocaleString()}
            </span>
          </div>
          <div className="text-right hidden md:block">
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
          const heightPercent = (day.usage / stats.maxUsage) * 100;
          return (
            <div key={index} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-t transition-all duration-300 hover:opacity-80"
                style={{
                  height: `${heightPercent}%`,
                  minHeight: '4px',
                  background: 'linear-gradient(to top, var(--color-primary), var(--color-secondary))',
                  opacity: 0.7 + (heightPercent / 100) * 0.3
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
  const credits = user?.credits || 0;
  const monthlyUsed = 256; // Mock
  const totalUsed = user?.total_credits_used || 0;

  // Mock transactions
  const transactions: Transaction[] = [
    { id: '1', type: 'usage', amount: -15, balance_after: 769, description: 'AI 智能对话', created_date: new Date().toISOString() },
    { id: '2', type: 'usage', amount: -8, balance_after: 784, description: '文案生成', created_date: new Date(Date.now() - 3600000).toISOString() },
    { id: '3', type: 'purchase', amount: 500, balance_after: 792, description: '购买积分包', created_date: new Date(Date.now() - 86400000).toISOString() },
    { id: '4', type: 'bonus', amount: 50, balance_after: 292, description: '邀请好友奖励', created_date: new Date(Date.now() - 172800000).toISOString() },
  ];

  const typeLabels: Record<string, string> = {
    purchase: '购买积分',
    usage: '积分消耗',
    bonus: '积分奖励',
    refund: '积分退款',
    admin_adjustment: '管理员调整',
    membership: '会员权益',
    checkin: '签到奖励'
  };

  const typeIcons: Record<string, { icon: typeof Package; color: string }> = {
    purchase: { icon: Package, color: 'var(--success)' },
    usage: { icon: Zap, color: 'var(--color-primary)' },
    bonus: { icon: Crown, color: 'var(--color-secondary)' },
    refund: { icon: RefreshCw, color: 'rgba(139, 92, 246, 1)' },
    admin_adjustment: { icon: Settings, color: 'var(--text-tertiary)' },
    membership: { icon: Crown, color: 'var(--color-primary)' },
    checkin: { icon: CheckCircle2, color: 'var(--success)' }
  };

  return (
    <>
      {/* 积分概览 */}
      <div
        className="rounded-2xl p-6 md:p-8 mb-6 transition-all duration-300"
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
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-8">
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
                {credits.toLocaleString()}
              </div>
            </div>

            <div className="pl-8 hidden md:block" style={{ borderLeft: '1px solid var(--border-primary)' }}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>本月消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{monthlyUsed.toLocaleString()}</div>
            </div>

            <div className="pl-8 hidden md:block" style={{ borderLeft: '1px solid var(--border-primary)' }}>
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

        <div className="space-y-4">
          {transactions.map((tx) => {
            const typeConfig = typeIcons[tx.type] || typeIcons.usage;
            const Icon = typeConfig.icon;
            const txDate = new Date(tx.created_date);

            return (
              <div
                key={tx.id}
                className="flex flex-col md:flex-row md:items-center justify-between p-4 rounded-xl transition-all duration-200"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-primary)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255, 215, 0, 0.2)';
                  e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-primary)';
                  e.currentTarget.style.boxShadow = 'none';
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
                      {typeLabels[tx.type] || tx.type}
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
                    <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>余额：{tx.balance_after}</div>
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

        <div className="flex items-center justify-between mt-8 pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>共 {transactions.length} 条记录</span>
        </div>
      </div>
    </>
  );
});
