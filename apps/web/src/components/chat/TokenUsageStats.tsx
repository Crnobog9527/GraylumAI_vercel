import { Activity, DollarSign, TrendingUp } from 'lucide-react';

interface TokenUsageStatsProps {
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCredits: number;
}

function formatCredits(value: number) {
  return value.toFixed(3);
}

export default function TokenUsageStats({
  lastInputTokens,
  lastOutputTokens,
  lastCredits,
  totalInputTokens,
  totalOutputTokens,
  totalCredits,
}: TokenUsageStatsProps) {
  if (
    lastInputTokens === 0 &&
    lastOutputTokens === 0 &&
    lastCredits === 0 &&
    totalInputTokens === 0 &&
    totalOutputTokens === 0 &&
    totalCredits === 0
  ) {
    return null;
  }

  return (
    <div
      className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4"
      data-testid="chat-token-usage-stats"
    >
      <div
        className="rounded-xl p-3"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <Activity className="h-3 w-3" />
          <span>本次输入</span>
        </div>
        <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {lastInputTokens.toLocaleString()}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>
          tokens
        </div>
      </div>

      <div
        className="rounded-xl p-3"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <Activity className="h-3 w-3" />
          <span>本次输出</span>
        </div>
        <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {lastOutputTokens.toLocaleString()}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>
          tokens
        </div>
      </div>

      <div
        className="rounded-xl p-3"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--info)',
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--info)' }}>
          <TrendingUp className="h-3 w-3" />
          <span>会话累计</span>
        </div>
        <div className="text-lg font-semibold" style={{ color: 'var(--info)' }}>
          {(totalInputTokens + totalOutputTokens).toLocaleString()}
        </div>
        <div className="text-xs" style={{ color: 'var(--info)' }}>
          {totalInputTokens.toLocaleString()} + {totalOutputTokens.toLocaleString()}
        </div>
      </div>

      <div
        className="rounded-xl p-3"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--success)',
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: 'var(--success)' }}>
          <DollarSign className="h-3 w-3" />
          <span>积分消耗</span>
        </div>
        <div className="text-lg font-semibold" style={{ color: 'var(--success)' }}>
          {formatCredits(totalCredits)}
        </div>
        <div className="text-xs" style={{ color: 'var(--success)' }}>
          本次: {formatCredits(lastCredits)} 积分
        </div>
      </div>
    </div>
  );
}
