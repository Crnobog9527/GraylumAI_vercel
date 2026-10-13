/**
 * Billing Types
 *
 * 计费相关类型定义
 * 支持三段式计费: 预扣 → 结算 → 退费
 */

import { z } from 'zod';

// ============================================
// 操作类型枚举
// ============================================

export const BillingOperationType = {
  PRE_DEDUCT: 'pre_deduct',
  SETTLE: 'settle',
  REFUND: 'refund',
  ABORT_SETTLE: 'abort_settle',
} as const;

export type BillingOperationType = typeof BillingOperationType[keyof typeof BillingOperationType];

// ============================================
// 计费状态
// ============================================

export const BillingStatus = {
  PENDING: 'pending', // 预扣完成，等待结算
  SETTLED: 'settled', // 已结算
  REFUNDED: 'refunded', // 已退费
  FAILED: 'failed', // 失败
} as const;

export type BillingStatus = typeof BillingStatus[keyof typeof BillingStatus];

// ============================================
// Zod Schemas
// ============================================

/**
 * 计费记录查询
 */
export const BillingQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  operationType: z.enum(['pre_deduct', 'settle', 'refund', 'abort_settle']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

/**
 * 计费历史记录
 */
export const BillingHistoryRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  transactionId: z.string().uuid().nullable(),
  operationType: z.enum(['pre_deduct', 'settle', 'refund', 'abort_settle']),
  amount: z.number(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

/**
 * 用户余额信息
 */
export const UserBalanceSchema = z.object({
  userId: z.string().uuid(),
  currentCredits: z.number(),
  pendingDeductions: z.number(), // 未结算的预扣总额
  availableCredits: z.number(), // 可用积分 = 当前积分 - 未结算预扣
  lastUpdated: z.string().datetime(),
});

/**
 * 消费统计
 */
export const UsageStatsSchema = z.object({
  userId: z.string().uuid(),
  period: z.enum(['daily', 'weekly', 'monthly']),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  stats: z.object({
    totalCreditsUsed: z.number(),
    totalCostUsd: z.number(),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalCachedTokens: z.number(),
    cacheHitRate: z.number(), // 缓存命中率 (0-1)
    totalWebSearches: z.number(),
    requestCount: z.number(),
    avgCostPerRequest: z.number(),
  }),
  modelBreakdown: z.array(z.object({
    modelId: z.string(),
    creditsUsed: z.number(),
    requestCount: z.number(),
    percentage: z.number(),
  })),
});

// ============================================
// 导出 TypeScript 类型
// ============================================

export type BillingQuery = z.infer<typeof BillingQuerySchema>;
export type BillingHistoryRecord = z.infer<typeof BillingHistoryRecordSchema>;
export type UserBalance = z.infer<typeof UserBalanceSchema>;
export type UsageStats = z.infer<typeof UsageStatsSchema>;

// ============================================
// 常量
// ============================================

/**
 * 计费相关常量
 */
export const BILLING_CONSTANTS = {
  // 积分与美元兑换比例 (1美元 = X积分)。只在 system_settings 确认没有这一行时使用。
  // Owner 已定 q=100、m=3，但 staging 改值要另行批准：届时写入显式配置行，
  // 不靠改这里的缺省值，避免合并代码本身改变某个环境的生效值（见 services/billingUnit.ts）。
  CREDITS_PER_USD: 1000,

  // 全站默认加价倍数（缺省值，规则同上）；模型可单独覆盖
  TOKEN_PRICE_MULTIPLIER: 1.5, // 用户价格 = API 成本 * 1.5
} as const;
