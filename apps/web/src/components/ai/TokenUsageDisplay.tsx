'use client';

/**
 * TokenUsageDisplay Component
 *
 * 显示 Token 使用统计和成本
 */

import React from 'react';
import { Coins, Zap, Database } from 'lucide-react';

// ============================================
// 类型定义
// ============================================

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface Cost {
  credits: number;
  costUsd: number;
}

interface TokenUsageDisplayProps {
  usage: TokenUsage;
  cost?: Cost | null;
  compact?: boolean;
  className?: string;
}

// ============================================
// 工具函数
// ============================================

/**
 * 格式化数字
 */
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * 计算缓存命中率
 */
function calculateCacheHitRate(usage: TokenUsage): number {
  const totalInput = usage.inputTokens + (usage.cacheReadTokens ?? 0);
  if (totalInput === 0) return 0;
  return Math.round(((usage.cacheReadTokens ?? 0) / totalInput) * 100);
}

// ============================================
// 组件实现
// ============================================

export function TokenUsageDisplay({
  usage,
  cost,
  compact = false,
  className = '',
}: TokenUsageDisplayProps) {
  const cacheHitRate = calculateCacheHitRate(usage);
  const totalTokens = usage.inputTokens + usage.outputTokens;

  if (compact) {
    return (
      <div className={`flex items-center gap-3 text-xs text-muted-foreground ${className}`}>
        {/* Token 使用 */}
        <span className="flex items-center gap-1">
          <Zap className="w-3 h-3" />
          {formatNumber(totalTokens)} tokens
        </span>

        {/* 缓存 */}
        {(usage.cacheReadTokens ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <Database className="w-3 h-3" />
            {cacheHitRate}% 缓存
          </span>
        )}

        {/* 成本 */}
        {cost && (
          <span className="flex items-center gap-1">
            <Coins className="w-3 h-3" />
            {cost.credits} 积分
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Token 详情 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">输入 Token</p>
          <p className="text-lg font-semibold">{formatNumber(usage.inputTokens)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">输出 Token</p>
          <p className="text-lg font-semibold">{formatNumber(usage.outputTokens)}</p>
        </div>
      </div>

      {/* 缓存统计 */}
      {((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheCreationTokens ?? 0) > 0) && (
        <div className="pt-3 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">缓存统计</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-green-600" />
              <span className="text-sm">
                读取: {formatNumber(usage.cacheReadTokens ?? 0)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">
                写入: {formatNumber(usage.cacheCreationTokens ?? 0)}
              </span>
            </div>
          </div>

          {/* 缓存命中率进度条 */}
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>缓存命中率</span>
              <span>{cacheHitRate}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-green-600 transition-all duration-300"
                style={{ width: `${cacheHitRate}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 成本 */}
      {cost && (
        <div className="pt-3 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">成本</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-yellow-600" />
              <span className="text-lg font-semibold">{cost.credits} 积分</span>
            </div>
            <span className="text-sm text-muted-foreground">
              ≈ ${cost.costUsd.toFixed(4)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default TokenUsageDisplay;
