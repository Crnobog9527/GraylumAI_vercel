'use client';

import React from 'react';
import { Activity, TrendingUp, DollarSign } from 'lucide-react';

interface Message {
  role: string;
  input_tokens?: number;
  output_tokens?: number;
}

interface TokenUsageStatsProps {
  messages: Message[];
  currentModel?: string;
}

export default function TokenUsageStats({
  messages,
}: TokenUsageStatsProps) {
  // 计算最后一次请求的 tokens
  const lastAssistantMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant');

  const lastInputTokens = lastAssistantMessage?.input_tokens || 0;
  const lastOutputTokens = lastAssistantMessage?.output_tokens || 0;

  // 计算会话累计 tokens
  const totalInputTokens = messages
    .filter((m) => m.role === 'assistant')
    .reduce((sum, m) => sum + (m.input_tokens || 0), 0);

  const totalOutputTokens = messages
    .filter((m) => m.role === 'assistant')
    .reduce((sum, m) => sum + (m.output_tokens || 0), 0);

  // 计算积分消耗（新规则）
  const calculateCredits = (inputTokens: number, outputTokens: number) => {
    const inputCredits = inputTokens / 1000; // 1积分 = 1000 tokens
    const outputCredits = outputTokens / 200; // 1积分 = 200 tokens
    return inputCredits + outputCredits;
  };

  const lastCredits = calculateCredits(lastInputTokens, lastOutputTokens);
  const totalCredits = calculateCredits(totalInputTokens, totalOutputTokens);

  if (messages.length === 0) return null;

  return (
    <div
      className="px-4 py-3"
      style={{
        borderTop: '1px solid var(--border-primary)',
        background: 'var(--bg-secondary)',
      }}
    >
      <div className="max-w-3xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* 本次输入 */}
          <div
            className="rounded-lg p-3"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <div
              className="flex items-center gap-2 text-xs mb-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <Activity className="h-3 w-3" />
              <span>本次输入</span>
            </div>
            <div
              className="text-lg font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {lastInputTokens.toLocaleString()}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>
              tokens ≈ {(lastInputTokens / 1000).toFixed(3)}积分
            </div>
          </div>

          {/* 本次输出 */}
          <div
            className="rounded-lg p-3"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <div
              className="flex items-center gap-2 text-xs mb-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <Activity className="h-3 w-3" />
              <span>本次输出</span>
            </div>
            <div
              className="text-lg font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {lastOutputTokens.toLocaleString()}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-disabled)' }}>
              tokens ≈ {(lastOutputTokens / 200).toFixed(3)}积分
            </div>
          </div>

          {/* 累计使用 */}
          <div
            className="rounded-lg p-3"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--info)',
            }}
          >
            <div
              className="flex items-center gap-2 text-xs mb-1"
              style={{ color: 'var(--info)' }}
            >
              <TrendingUp className="h-3 w-3" />
              <span>会话累计</span>
            </div>
            <div
              className="text-lg font-semibold"
              style={{ color: 'var(--info)' }}
            >
              {(totalInputTokens + totalOutputTokens).toLocaleString()}
            </div>
            <div className="text-xs" style={{ color: 'var(--info)' }}>
              {totalInputTokens.toLocaleString()} + {totalOutputTokens.toLocaleString()}
            </div>
          </div>

          {/* 积分消耗 */}
          <div
            className="rounded-lg p-3"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--success)',
            }}
          >
            <div
              className="flex items-center gap-2 text-xs mb-1"
              style={{ color: 'var(--success)' }}
            >
              <DollarSign className="h-3 w-3" />
              <span>积分消耗</span>
            </div>
            <div
              className="text-lg font-semibold"
              style={{ color: 'var(--success)' }}
            >
              {totalCredits.toFixed(3)}
            </div>
            <div className="text-xs" style={{ color: 'var(--success)' }}>
              本次: {lastCredits.toFixed(3)}积分
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
