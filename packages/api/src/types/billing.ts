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
 * 预扣请求
 */
export const PreDeductRequestSchema = z.object({
  userId: z.string().uuid(),
  estimatedCredits: z.number().positive('预扣积分必须为正数'),
  reason: z.string().optional().default('AI 对话预扣'),
  conversationId: z.string().uuid().optional(),
});

/**
 * 结算请求
 */
export const SettleRequestSchema = z.object({
  preDeductId: z.string().uuid(),
  actualCredits: z.number().nonnegative('实际积分不能为负'),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    webSearchCount: z.number().optional(),
  }),
  modelUsed: z.string(),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
});

/**
 * 退费请求
 */
export const RefundRequestSchema = z.object({
  preDeductId: z.string().uuid(),
  reason: z.string(),
  partialRefund: z.number().nonnegative().optional(), // 部分退费金额，不填则全额退费
});

/**
 * 计费记录查询
 */
export const BillingQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  operationType: z.enum(['pre_deduct', 'settle', 'refund']).optional(),
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
  operationType: z.enum(['pre_deduct', 'settle', 'refund']),
  amount: z.number(),
  reason: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
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
 * 成本估算请求
 */
export const CostEstimateRequestSchema = z.object({
  modelId: z.string(),
  estimatedInputTokens: z.number(),
  estimatedOutputTokens: z.number(),
  enableWebSearch: z.boolean().optional(),
  webSearchCount: z.number().optional(),
});

/**
 * 成本估算响应
 */
export const CostEstimateResponseSchema = z.object({
  estimatedCredits: z.number(),
  estimatedCostUsd: z.number(),
  breakdown: z.object({
    inputCost: z.number(),
    outputCost: z.number(),
    searchCost: z.number(),
    total: z.number(),
  }),
  safetyMargin: z.number(), // 安全边际 (建议预扣额外的比例)
  recommendedPreDeduct: z.number(), // 建议预扣金额
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

export type PreDeductRequest = z.infer<typeof PreDeductRequestSchema>;
export type SettleRequest = z.infer<typeof SettleRequestSchema>;
export type RefundRequest = z.infer<typeof RefundRequestSchema>;
export type BillingQuery = z.infer<typeof BillingQuerySchema>;
export type BillingHistoryRecord = z.infer<typeof BillingHistoryRecordSchema>;
export type UserBalance = z.infer<typeof UserBalanceSchema>;
export type CostEstimateRequest = z.infer<typeof CostEstimateRequestSchema>;
export type CostEstimateResponse = z.infer<typeof CostEstimateResponseSchema>;
export type UsageStats = z.infer<typeof UsageStatsSchema>;

// ============================================
// 计费服务接口
// ============================================

/**
 * 计费服务接口定义
 */
export interface IBillingService {
  /**
   * 预扣积分
   * @returns 预扣记录 ID
   */
  preDeduct(request: PreDeductRequest): Promise<string>;

  /**
   * 结算积分
   */
  settle(request: SettleRequest): Promise<void>;

  /**
   * 退费
   */
  refund(request: RefundRequest): Promise<void>;

  /**
   * 获取用户余额
   */
  getBalance(userId: string): Promise<UserBalance>;

  /**
   * 估算成本
   */
  estimateCost(request: CostEstimateRequest): Promise<CostEstimateResponse>;

  /**
   * 获取消费统计
   */
  getUsageStats(userId: string, period: 'daily' | 'weekly' | 'monthly'): Promise<UsageStats>;
}

// ============================================
// 错误类型
// ============================================

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly userId: string,
    public readonly required: number,
    public readonly available: number,
  ) {
    super(`积分不足: 需要 ${required}，当前可用 ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export class BillingNotFoundError extends Error {
  constructor(public readonly billingId: string) {
    super(`计费记录不存在: ${billingId}`);
    this.name = 'BillingNotFoundError';
  }
}

export class InvalidBillingOperationError extends Error {
  constructor(
    public readonly operation: string,
    public readonly reason: string,
  ) {
    super(`无效的计费操作 (${operation}): ${reason}`);
    this.name = 'InvalidBillingOperationError';
  }
}

// ============================================
// 常量
// ============================================

/**
 * 计费相关常量
 */
export const BILLING_CONSTANTS = {
  // 预扣安全边际 (预扣时额外增加的比例)
  SAFETY_MARGIN: 0.2, // 20%

  // 最小预扣金额
  MIN_PRE_DEDUCT: 10,

  // 最大预扣金额
  MAX_PRE_DEDUCT: 10000,

  // 预扣超时时间 (毫秒) - 超过此时间未结算则自动退费
  PRE_DEDUCT_TIMEOUT: 5 * 60 * 1000, // 5 分钟

  // 积分与美元兑换比例 (1美元 = X积分)
  CREDITS_PER_USD: 1000,

  // Token 价格倍率 (基于 Claude API 价格)
  TOKEN_PRICE_MULTIPLIER: 1.5, // 用户价格 = API 成本 * 1.5
} as const;

/**
 * 模型定价表 (每百万 Token 美元)
 */
export const MODEL_PRICING = {
  // Claude Sonnet 4
  'claude-sonnet-4-20250514': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
  },
  // Claude Haiku 3.5
  'claude-3-5-haiku-20241022': {
    inputPer1M: 0.80,
    outputPer1M: 4.0,
    cacheWritePer1M: 1.0,
    cacheReadPer1M: 0.08,
  },
  // Claude Opus 4
  'claude-opus-4-20250514': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.50,
  },
} as const;

export type SupportedModelId = keyof typeof MODEL_PRICING;
