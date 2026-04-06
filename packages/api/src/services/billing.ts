/**
 * Billing Service - 原子化计费服务
 *
 * 实现三段式计费: 预扣 → 结算 → 退费
 * 确保计费事务的原子性和一致性
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BILLING_CONSTANTS,
  MODEL_PRICING,
  type SupportedModelId,
  InsufficientCreditsError,
  BillingNotFoundError,
  InvalidBillingOperationError,
} from '../types/billing';
import { type TokenUsage, type CostBreakdown } from '../types/ai';
import { logger } from '../lib/logger';
import { applyInvitationRebateForSpend } from './invitationRebate';

// ============================================
// 类型定义
// ============================================

export interface PreDeductResult {
  preDeductId: string;
  estimatedCredits: number;
  balanceBefore: number;
  balanceAfter: number;
  /** 如果是重复请求，返回之前的响应 */
  idempotent?: boolean;
}

export interface IdempotencyCheckResult {
  /** 是否已存在该请求 */
  exists: boolean;
  /** 如果存在，返回之前的预扣记录ID */
  preDeductId?: string;
  /** 如果已完成，返回结果 */
  result?: {
    messageId: string;
    conversationId: string;
    content: string;
  };
}

export interface SettleResult {
  actualCredits: number;
  difference: number; // 正数为退还，负数为补扣
  balanceAfter: number;
}

export interface RefundResult {
  refundAmount: number;
  balanceAfter: number;
}

export interface AbortSettleResult {
  /** 中断时已消耗的积分 */
  consumedCredits: number;
  /** 退还的积分 */
  refundedCredits: number;
  /** 结算后余额 */
  balanceAfter: number;
}

export interface BillingContext {
  supabase: SupabaseClient;
  userId: string;
}

export interface FinalizeAISuccessParams {
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
  modelUsed: string;
  usage: TokenUsage;
  costUsd: number;
  credits: number;
  preDeductId?: string | null;
  requestId?: string;
  inputLength?: number;
  latencyMs?: number;
  searchCount?: number;
  ipAddress?: string;
  userAgent?: string;
  tokenMetadata?: Record<string, unknown>;
  usageMetadata?: Record<string, unknown>;
}

export interface FinalizeAISuccessResult {
  userMessageId: string | null;
  assistantMessageId: string | null;
  transactionId: string | null;
  billingId: string | null;
  balanceAfter: number;
  refundedCredits: number;
}

export interface FinalizeAIFailureParams {
  modelUsed: string;
  reason: string;
  preDeductId?: string | null;
  conversationId?: string;
  requestId?: string;
  inputLength?: number;
  latencyMs?: number;
  ipAddress?: string;
  userAgent?: string;
  usageMetadata?: Record<string, unknown>;
}

// ============================================
// 模型定价查询 (从数据库读取)
// ============================================

/** 模型定价信息 */
export interface ModelPricingInfo {
  inputPer1M: number;      // 每百万输入 Token 成本 (美元)
  outputPer1M: number;     // 每百万输出 Token 成本 (美元)
  cacheWritePer1M?: number; // 缓存写入成本
  cacheReadPer1M?: number;  // 缓存读取成本
  searchPer1K?: number;     // 每千次搜索成本
}

/** 定价缓存 (避免每次请求都查询数据库) */
const pricingCache = new Map<string, { pricing: ModelPricingInfo; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeRequestId(requestId?: string | null): string | undefined {
  const trimmed = requestId?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (UUID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  logger.warn('billing', 'billing_request_id_invalid_uuid', {
    requestIdLength: trimmed.length,
  });

  return undefined;
}

/**
 * 从数据库获取模型定价
 * @param supabase - Supabase 客户端
 * @param modelId - 模型 ID (Claude API model ID, 如 'claude-sonnet-4-20250514')
 */
export async function getModelPricing(
  supabase: SupabaseClient,
  modelId: string
): Promise<ModelPricingInfo> {
  // 1. 检查缓存
  const cached = pricingCache.get(modelId);
  if (cached && cached.expiry > Date.now()) {
    return cached.pricing;
  }

  // 2. 从数据库查询
  const { data: model, error } = await supabase
    .from('ai_models')
    .select('input_token_cost, output_token_cost, web_search_cost')
    .eq('model_id', modelId)
    .eq('is_active', 'true')
    .single();

  if (error || !model) {
    // 数据库查询失败，使用硬编码后备
    console.warn(`[Billing] Model ${modelId} not found in database, using fallback pricing`);
    const fallback = MODEL_PRICING[modelId as SupportedModelId] ?? MODEL_PRICING['claude-sonnet-4-20250514'];
    return fallback;
  }

  // 3. 转换数据库格式 (微美元 → 美元)
  // 数据库存储: 每百万 Token 的微美元成本 (如 3000000 = $3.00)
  const pricing: ModelPricingInfo = {
    inputPer1M: (model.input_token_cost ?? 0) / 1_000_000,
    outputPer1M: (model.output_token_cost ?? 0) / 1_000_000,
    // 缓存定价使用标准比例 (写入=1.25x输入, 读取=0.1x输入)
    cacheWritePer1M: ((model.input_token_cost ?? 0) / 1_000_000) * 1.25,
    cacheReadPer1M: ((model.input_token_cost ?? 0) / 1_000_000) * 0.1,
    searchPer1K: (model.web_search_cost ?? 0) / 1_000,
  };

  // 4. 如果数据库定价为0，使用硬编码后备
  if (pricing.inputPer1M === 0 || pricing.outputPer1M === 0) {
    console.warn(`[Billing] Model ${modelId} has zero pricing, using fallback`);
    const fallback = MODEL_PRICING[modelId as SupportedModelId] ?? MODEL_PRICING['claude-sonnet-4-20250514'];
    return fallback;
  }

  // 5. 缓存结果
  pricingCache.set(modelId, { pricing, expiry: Date.now() + CACHE_TTL });

  return pricing;
}

// ============================================
// 成本计算工具
// ============================================

/**
 * 计算 Token 成本 (积分) - 使用硬编码定价 (后备)
 * @deprecated 建议使用 calculateTokenCostWithPricing 传入动态定价
 */
export function calculateTokenCost(
  modelId: string,
  usage: TokenUsage
): { credits: number; costUsd: number; breakdown: CostBreakdown } {
  // 获取模型定价 (硬编码后备)
  const pricing = MODEL_PRICING[modelId as SupportedModelId] ?? MODEL_PRICING['claude-sonnet-4-20250514'];
  return calculateTokenCostWithPricing(usage, pricing);
}

/**
 * 计算 Token 成本 (积分) - 使用传入的定价信息
 */
export function calculateTokenCostWithPricing(
  usage: TokenUsage,
  pricing: ModelPricingInfo,
  options: { searchCount?: number } = {}
): { credits: number; costUsd: number; breakdown: CostBreakdown } {
  // 计算各项成本 (美元)
  const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const cacheWriteCostUsd = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * (pricing.cacheWritePer1M ?? 0);
  const cacheReadCostUsd = ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheReadPer1M ?? 0);
  const searchCostUsd = ((options.searchCount ?? 0) / 1000) * (pricing.searchPer1K ?? 0);

  const totalCostUsd = inputCostUsd + outputCostUsd + cacheWriteCostUsd + cacheReadCostUsd + searchCostUsd;

  // 转换为积分 (应用价格倍率)
  const totalCredits = Math.ceil(
    totalCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER
  );

  // 成本明细 (积分)
  const breakdown: CostBreakdown = {
    input: Math.ceil(inputCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
    output: Math.ceil(outputCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
    cacheWrite: Math.ceil(cacheWriteCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
    cacheRead: Math.ceil(cacheReadCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
    search: Math.ceil(searchCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
    total: totalCredits,
  };

  return {
    credits: totalCredits,
    costUsd: totalCostUsd,
    breakdown,
  };
}

/**
 * 估算请求成本 (用于预扣)
 */
export function estimateRequestCost(
  modelId: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number = 4096
): number {
  const usage: TokenUsage = {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  const { credits } = calculateTokenCost(modelId, usage);

  // 添加安全边际
  const withMargin = Math.ceil(credits * (1 + BILLING_CONSTANTS.SAFETY_MARGIN));

  // 确保在最小和最大预扣范围内
  return Math.max(
    BILLING_CONSTANTS.MIN_PRE_DEDUCT,
    Math.min(BILLING_CONSTANTS.MAX_PRE_DEDUCT, withMargin)
  );
}

// ============================================
// Billing Service 类
// ============================================

export class BillingService {
  private supabase: SupabaseClient;
  private userId: string;

  constructor(ctx: BillingContext) {
    this.supabase = ctx.supabase;
    this.userId = ctx.userId;
  }

  private async applyInvitationRebate(consumedCredits: number, preDeductId: string) {
    try {
      await applyInvitationRebateForSpend({
        supabase: this.supabase,
        inviteeId: this.userId,
        consumedCredits,
        preDeductId,
      });
    } catch (error) {
      console.error('[Billing] Failed to apply invitation rebate:', error);
    }
  }

  private async persistMessages(conversationId: string, userMessage: string, assistantMessage: string) {
    const { data, error } = await this.supabase
      .from('messages')
      .insert([
        {
          conversation_id: conversationId,
          role: 'user',
          content: userMessage,
        },
        {
          conversation_id: conversationId,
          role: 'assistant',
          content: assistantMessage,
        },
      ])
      .select('id, role');

    if (error) {
      throw new Error(`Failed to persist AI messages: ${error.message}`);
    }

    return {
      userMessageId: data?.find((item: { role: string }) => item.role === 'user')?.id ?? null,
      assistantMessageId: data?.find((item: { role: string }) => item.role === 'assistant')?.id ?? null,
    };
  }

  /**
   * 验证成本合理性 (P1-8)
   * 确保 actualCredits 与 usage tokens 一致，防止数据篡改
   */
  private verifyCost(actualCredits: number, usage: TokenUsage): void {
    // 1. 基本验证
    if (actualCredits < 0) {
      throw new InvalidBillingOperationError('settle', '积分不能为负数');
    }

    // 2. Token 使用量验证
    if (usage.inputTokens < 0 || usage.outputTokens < 0) {
      throw new InvalidBillingOperationError('settle', 'Token 数量不能为负数');
    }

    // 3. 验证 actualCredits 与 usage 的一致性
    // 使用宽松的估算: 1 积分 ≈ 10-1000 tokens (取决于模型)
    const totalTokens = usage.inputTokens + usage.outputTokens;

    // 如果 tokens 不为 0，积分也不应该为 0 (除非 tokens 极少)
    if (totalTokens > 100 && actualCredits === 0) {
      console.warn('[Billing] Warning: Tokens used but credits is 0', {
        totalTokens,
        actualCredits,
        usage,
      });
    }

    // 如果积分异常高 (超过 tokens 的合理比例)，发出警告
    // 假设最高定价: 1 积分 ≈ 10 tokens，如果比例超过 1:1 则异常
    if (totalTokens > 0 && actualCredits > totalTokens) {
      console.warn('[Billing] Warning: Unusual credits/tokens ratio', {
        ratio: actualCredits / totalTokens,
        actualCredits,
        totalTokens,
        usage,
      });
    }

    // 4. 单次请求上限检查 (防止异常大额结算)
    const MAX_SINGLE_SETTLE = BILLING_CONSTANTS.MAX_PRE_DEDUCT * 2; // 允许超过预扣2倍
    if (actualCredits > MAX_SINGLE_SETTLE) {
      throw new InvalidBillingOperationError(
        'settle',
        `单次结算金额过大 (${actualCredits} > ${MAX_SINGLE_SETTLE})，请联系管理员`
      );
    }
  }

  /**
   * 检查请求幂等性
   * 如果该 requestId 已经处理过，返回之前的结果
   */
  async checkIdempotency(requestId: string): Promise<IdempotencyCheckResult> {
    // 检查是否已有该 requestId 的预扣记录
    const { data: existingRecord } = await this.supabase
      .from('billing_history')
      .select('id, metadata')
      .eq('user_id', this.userId)
      .eq('operation_type', 'pre_deduct')
      .contains('metadata', { requestId })
      .single();

    if (!existingRecord) {
      return { exists: false };
    }

    // 检查是否已结算（已完成的请求）
    const { data: settleRecord } = await this.supabase
      .from('billing_history')
      .select('metadata')
      .eq('user_id', this.userId)
      .eq('operation_type', 'settle')
      .contains('metadata', { preDeductId: existingRecord.id })
      .single();

    if (settleRecord) {
      // 请求已完成，返回之前的结果
      const metadata = settleRecord.metadata as Record<string, unknown>;
      return {
        exists: true,
        preDeductId: existingRecord.id,
        result: metadata?.response as IdempotencyCheckResult['result'],
      };
    }

    // 请求正在处理中
    return {
      exists: true,
      preDeductId: existingRecord.id,
    };
  }

  /**
   * 获取用户当前余额
   */
  async getBalance(): Promise<number> {
    const { data: profile, error } = await this.supabase
      .from('profiles')
      .select('credits')
      .eq('id', this.userId)
      .single();

    if (error || !profile) {
      throw new Error('无法获取用户余额');
    }

    return profile.credits ?? 0;
  }

  /**
   * 预扣积分 (请求开始前) - 使用原子化 RPC 函数
   *
   * @param estimatedCredits - 预估需要的积分
   * @param options - 可选配置
   * @param options.reason - 预扣原因
   * @param options.requestId - 幂等性 Key (用于防止重复扣费)
   * @returns 预扣记录 ID 和相关信息
   */
  async preDeduct(
    estimatedCredits: number,
    options: { reason?: string; requestId?: string } | string = {}
  ): Promise<PreDeductResult> {
    const normalizedOptions = typeof options === 'string' ? { reason: options } : options;
    const { reason = 'AI 对话预扣' } = normalizedOptions;
    const requestId = normalizeRequestId(normalizedOptions.requestId);

    // 尝试使用原子化 RPC 函数
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    let rpcResult: any[] | null = null;
    let rpcError: { message: string } | null = null;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_pre_deduct', {
        p_user_id: this.userId,
        p_amount: estimatedCredits,
        p_reason: reason,
        p_request_id: requestId ?? null,
      });
      rpcResult = rpcResponse.data;
      rpcError = rpcResponse.error;
    } else {
      rpcError = { message: 'RPC function missing on supabase client' };
    }

    // 如果 RPC 函数存在且执行成功
    if (!rpcError && rpcResult && rpcResult.length > 0) {
      const result = rpcResult[0];
      return {
        preDeductId: result.pre_deduct_id,
        estimatedCredits,
        balanceBefore: result.balance_before,
        balanceAfter: result.balance_after,
        idempotent: result.is_idempotent,
      };
    }

    // RPC 函数不存在或失败，回退到原有逻辑
    if (rpcError) {
      console.warn('[Billing] RPC not available, falling back to optimistic lock:', rpcError.message);
    }

    // 0. 幂等性检查 (如果提供了 requestId)
    if (requestId) {
      const idempotencyCheck = await this.checkIdempotency(requestId);
      if (idempotencyCheck.exists) {
        // 请求已存在，返回之前的记录
        // 获取之前的预扣信息
        const { data: existingPreDeduct } = await this.supabase
          .from('billing_history')
          .select('metadata')
          .eq('id', idempotencyCheck.preDeductId)
          .single();

        const metadata = existingPreDeduct?.metadata as Record<string, number> | null;
        return {
          preDeductId: idempotencyCheck.preDeductId!,
          estimatedCredits,
          balanceBefore: metadata?.balance_before ?? 0,
          balanceAfter: metadata?.balance_after ?? 0,
          idempotent: true,
        };
      }
    }

    // 1. 获取当前余额并加锁 (使用乐观锁)
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select('credits, updated_at')
      .eq('id', this.userId)
      .single();

    if (profileError || !profile) {
      throw new Error('用户资料不存在');
    }

    const currentCredits = profile.credits ?? 0;

    // 2. 余额检查
    if (currentCredits < estimatedCredits) {
      logger.billing.insufficient(this.userId, estimatedCredits, currentCredits);
      throw new InsufficientCreditsError(this.userId, estimatedCredits, currentCredits);
    }

    const newCredits = currentCredits - estimatedCredits;

    // 3. 使用乐观锁更新余额
    const { data: updateResult, error: updateError } = await this.supabase
      .from('profiles')
      .update({
        credits: newCredits,
        updated_at: new Date().toISOString(),
      })
      .eq('id', this.userId)
      .eq('updated_at', profile.updated_at)
      .select('credits')
      .single();

    if (updateError || !updateResult) {
      throw new Error('积分更新冲突，请重试');
    }

    // 4. 记录预扣历史 (包含 requestId 用于幂等性检查)
    const { data: billingRecord, error: billingError } = await this.supabase
      .from('billing_history')
      .insert({
        user_id: this.userId,
        operation_type: 'pre_deduct',
        amount: -estimatedCredits,
        reason,
        metadata: {
          balance_before: currentCredits,
          balance_after: newCredits,
          timestamp: new Date().toISOString(),
          ...(requestId && { requestId }), // 存储 requestId 用于幂等性检查
        },
      })
      .select('id')
      .single();

    if (billingError || !billingRecord) {
      // 预扣成功但记录失败，需要告警
      console.error('Failed to record pre-deduct:', billingError);
      throw new Error('计费记录失败');
    }

    // 记录日志
    logger.billing.preDeduct(
      this.userId,
      estimatedCredits,
      requestId ?? billingRecord.id,
      { balanceBefore: currentCredits, balanceAfter: newCredits }
    );

    return {
      preDeductId: billingRecord.id,
      estimatedCredits,
      balanceBefore: currentCredits,
      balanceAfter: newCredits,
    };
  }

  /**
   * 结算 (请求完成后) - 使用原子化 RPC 函数
   *
   * @param preDeductId - 预扣记录 ID
   * @param actualCredits - 实际消耗的积分
   * @param usage - Token 使用详情
   * @param response - 响应信息 (用于幂等性缓存)
   */
  async settle(
    preDeductId: string,
    actualCredits: number,
    usage: TokenUsage,
    response?: { messageId: string; conversationId: string; content: string }
  ): Promise<SettleResult> {
    // 成本验证 (P1-8)
    this.verifyCost(actualCredits, usage);

    // 尝试使用原子化 RPC 函数
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    let rpcResult: any[] | null = null;
    let rpcError: { message: string } | null = null;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_settle', {
        p_user_id: this.userId,
        p_pre_deduct_id: preDeductId,
        p_actual_credits: actualCredits,
        p_usage: usage,
        p_response: response ?? null,
      });
      rpcResult = rpcResponse.data;
      rpcError = rpcResponse.error;
    } else {
      rpcError = { message: 'RPC function missing on supabase client' };
    }

    // 如果 RPC 函数存在且执行成功
    if (!rpcError && rpcResult && rpcResult.length > 0) {
      const result = rpcResult[0];
      await this.applyInvitationRebate(result.actual_credits, preDeductId);
      return {
        actualCredits: result.actual_credits,
        difference: result.difference,
        balanceAfter: result.balance_after,
      };
    }

    // RPC 函数不存在或失败，回退到原有逻辑
    if (rpcError) {
      console.warn('[Billing] RPC not available, falling back to optimistic lock:', rpcError.message);
    }

    // 1. 获取预扣记录
    const { data: preDeduct, error: preDeductError } = await this.supabase
      .from('billing_history')
      .select('*')
      .eq('id', preDeductId)
      .eq('user_id', this.userId)
      .eq('operation_type', 'pre_deduct')
      .single();

    if (preDeductError || !preDeduct) {
      throw new BillingNotFoundError(preDeductId);
    }

    // 检查是否已结算
    const { data: existingSettle } = await this.supabase
      .from('billing_history')
      .select('id')
      .eq('operation_type', 'settle')
      .contains('metadata', { preDeductId })
      .single();

    if (existingSettle) {
      throw new InvalidBillingOperationError('settle', '该预扣记录已结算');
    }

    const preDeductedAmount = Math.abs(preDeduct.amount);
    const difference = preDeductedAmount - actualCredits;

    // 2. 处理差额
    if (difference !== 0) {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('credits, updated_at')
        .eq('id', this.userId)
        .single();

      if (!profile) {
        throw new Error('用户资料不存在');
      }

      const newCredits = difference > 0
        ? profile.credits + difference  // 退还多扣的
        : profile.credits - Math.abs(difference); // 补扣不足的

      const { error: updateError } = await this.supabase
        .from('profiles')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', this.userId)
        .eq('updated_at', profile.updated_at);

      if (updateError) {
        throw new Error('积分调整失败');
      }
    }

    // 3. 记录结算 (包含 response 用于幂等性缓存)
    const { error: settleError } = await this.supabase
      .from('billing_history')
      .insert({
        user_id: this.userId,
        operation_type: 'settle',
        amount: -actualCredits,
        reason: 'AI 对话结算',
        metadata: {
          preDeductId,
          preDeductedAmount,
          actualCredits,
          difference,
          usage,
          timestamp: new Date().toISOString(),
          ...(response && { response }), // 存储响应用于幂等性返回
        },
      });

    if (settleError) {
      console.error('Failed to record settle:', settleError);
    }

    // 4. 获取最新余额
    const { data: finalProfile } = await this.supabase
      .from('profiles')
      .select('credits')
      .eq('id', this.userId)
      .single();

    // 记录日志
    logger.billing.settle(
      this.userId,
      preDeductedAmount,
      actualCredits,
      difference > 0 ? difference : 0,
      preDeductId,
      { balanceAfter: finalProfile?.credits ?? 0 }
    );

    await this.applyInvitationRebate(actualCredits, preDeductId);

    return {
      actualCredits,
      difference,
      balanceAfter: finalProfile?.credits ?? 0,
    };
  }

  /**
   * 退费 (请求失败时) - 使用原子化 RPC 函数
   *
   * @param preDeductId - 预扣记录 ID
   * @param reason - 退费原因
   */
  async refund(preDeductId: string, reason: string): Promise<RefundResult> {
    // 尝试使用原子化 RPC 函数
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    let rpcResult: any[] | null = null;
    let rpcError: { message: string } | null = null;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_refund', {
        p_user_id: this.userId,
        p_pre_deduct_id: preDeductId,
        p_reason: reason,
      });
      rpcResult = rpcResponse.data;
      rpcError = rpcResponse.error;
    } else {
      rpcError = { message: 'RPC function missing on supabase client' };
    }

    // 如果 RPC 函数存在且执行成功
    if (!rpcError && rpcResult && rpcResult.length > 0) {
      const result = rpcResult[0];
      return {
        refundAmount: result.refund_amount,
        balanceAfter: result.balance_after,
      };
    }

    // RPC 函数不存在或失败，回退到原有逻辑
    if (rpcError) {
      console.warn('[Billing] RPC not available, falling back to optimistic lock:', rpcError.message);
    }

    // 1. 获取预扣记录
    const { data: preDeduct, error: preDeductError } = await this.supabase
      .from('billing_history')
      .select('*')
      .eq('id', preDeductId)
      .eq('user_id', this.userId)
      .eq('operation_type', 'pre_deduct')
      .single();

    if (preDeductError || !preDeduct) {
      throw new BillingNotFoundError(preDeductId);
    }

    // 检查是否已处理
    const { data: existingProcess } = await this.supabase
      .from('billing_history')
      .select('id, operation_type')
      .or(`metadata->preDeductId.eq.${preDeductId}`)
      .in('operation_type', ['settle', 'refund'])
      .single();

    if (existingProcess) {
      throw new InvalidBillingOperationError(
        'refund',
        `该预扣记录已${existingProcess.operation_type === 'settle' ? '结算' : '退费'}`
      );
    }

    const refundAmount = Math.abs(preDeduct.amount);

    // 2. 退还积分
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('credits, updated_at')
      .eq('id', this.userId)
      .single();

    if (!profile) {
      throw new Error('用户资料不存在');
    }

    const newCredits = profile.credits + refundAmount;

    const { error: updateError } = await this.supabase
      .from('profiles')
      .update({
        credits: newCredits,
        updated_at: new Date().toISOString(),
      })
      .eq('id', this.userId)
      .eq('updated_at', profile.updated_at);

    if (updateError) {
      throw new Error('退费失败');
    }

    // 3. 记录退费
    const { error: refundError } = await this.supabase
      .from('billing_history')
      .insert({
        user_id: this.userId,
        operation_type: 'refund',
        amount: refundAmount,
        reason,
        metadata: {
          preDeductId,
          refundAmount,
          timestamp: new Date().toISOString(),
        },
      });

    if (refundError) {
      console.error('Failed to record refund:', refundError);
    }

    // 记录日志
    logger.billing.refund(
      this.userId,
      refundAmount,
      preDeductId,
      reason,
      { balanceAfter: newCredits }
    );

    return {
      refundAmount,
      balanceAfter: newCredits,
    };
  }

  /**
   * 中断结算 (流式响应中断时) - 使用原子化 RPC 函数
   *
   * @param preDeductId - 预扣记录 ID
   * @param consumedTokens - 中断前已消耗的 tokens
   * @param modelId - 使用的模型 ID
   * @param reason - 中断原因
   */
  async settleAbort(
    preDeductId: string,
    consumedTokens: { inputTokens: number; outputTokens: number },
    modelId: string,
    reason: string = '用户中断'
  ): Promise<AbortSettleResult> {
    // 计算已消耗的成本
    const consumedUsage: TokenUsage = {
      inputTokens: consumedTokens.inputTokens,
      outputTokens: consumedTokens.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const { credits: consumedCredits } = calculateTokenCost(modelId, consumedUsage);

    // 尝试使用原子化 RPC 函数
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    let rpcResult: any[] | null = null;
    let rpcError: { message: string } | null = null;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_abort_settle', {
        p_user_id: this.userId,
        p_pre_deduct_id: preDeductId,
        p_consumed_credits: consumedCredits,
        p_consumed_tokens: consumedTokens,
        p_model_id: modelId,
        p_reason: reason,
      });
      rpcResult = rpcResponse.data;
      rpcError = rpcResponse.error;
    } else {
      rpcError = { message: 'RPC function missing on supabase client' };
    }

    // 如果 RPC 函数存在且执行成功
    if (!rpcError && rpcResult && rpcResult.length > 0) {
      const result = rpcResult[0];
      await this.applyInvitationRebate(result.consumed_credits, preDeductId);
      return {
        consumedCredits: result.consumed_credits,
        refundedCredits: result.refunded_credits,
        balanceAfter: result.balance_after,
      };
    }

    // RPC 函数不存在或失败，回退到原有逻辑
    if (rpcError) {
      console.warn('[Billing] RPC not available, falling back to optimistic lock:', rpcError.message);
    }

    // 1. 获取预扣记录
    const { data: preDeduct, error: preDeductError } = await this.supabase
      .from('billing_history')
      .select('*')
      .eq('id', preDeductId)
      .eq('user_id', this.userId)
      .eq('operation_type', 'pre_deduct')
      .single();

    if (preDeductError || !preDeduct) {
      throw new BillingNotFoundError(preDeductId);
    }

    // 检查是否已处理
    const { data: existingProcess } = await this.supabase
      .from('billing_history')
      .select('id, operation_type')
      .or(`metadata->preDeductId.eq.${preDeductId}`)
      .in('operation_type', ['settle', 'refund', 'abort_settle'])
      .single();

    if (existingProcess) {
      throw new InvalidBillingOperationError(
        'settleAbort',
        `该预扣记录已${existingProcess.operation_type === 'settle' ? '结算' : existingProcess.operation_type === 'refund' ? '退费' : '中断结算'}`
      );
    }

    const preDeductedAmount = Math.abs(preDeduct.amount);
    const refundedCredits = Math.max(0, preDeductedAmount - consumedCredits);

    // 3. 退还未使用的积分
    if (refundedCredits > 0) {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('credits, updated_at')
        .eq('id', this.userId)
        .single();

      if (!profile) {
        throw new Error('用户资料不存在');
      }

      const newCredits = profile.credits + refundedCredits;

      const { error: updateError } = await this.supabase
        .from('profiles')
        .update({
          credits: newCredits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', this.userId)
        .eq('updated_at', profile.updated_at);

      if (updateError) {
        throw new Error('积分退还失败');
      }
    }

    // 4. 记录中断结算
    const { error: abortError } = await this.supabase
      .from('billing_history')
      .insert({
        user_id: this.userId,
        operation_type: 'abort_settle',
        amount: -consumedCredits,
        reason,
        metadata: {
          preDeductId,
          preDeductedAmount,
          consumedCredits,
          refundedCredits,
          consumedTokens,
          modelId,
          timestamp: new Date().toISOString(),
        },
      });

    if (abortError) {
      console.error('Failed to record abort settle:', abortError);
    }

    // 5. 获取最新余额
    const { data: finalProfile } = await this.supabase
      .from('profiles')
      .select('credits')
      .eq('id', this.userId)
      .single();

    await this.applyInvitationRebate(consumedCredits, preDeductId);

    return {
      consumedCredits,
      refundedCredits,
      balanceAfter: finalProfile?.credits ?? 0,
    };
  }

  async finalizeAISuccess(params: FinalizeAISuccessParams): Promise<FinalizeAISuccessResult> {
    const requestId = normalizeRequestId(params.requestId);
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_finalize_ai_success', {
        p_user_id: this.userId,
        p_conversation_id: params.conversationId,
        p_user_message: params.userMessage,
        p_assistant_message: params.assistantMessage,
        p_model_used: params.modelUsed,
        p_total_cost_usd: params.costUsd.toFixed(6),
        p_total_credits: params.credits,
        p_pre_deduct_id: params.preDeductId ?? null,
        p_usage: params.usage,
        p_token_metadata: params.tokenMetadata ?? {},
        p_usage_metadata: params.usageMetadata ?? {},
        p_request_id: requestId ?? null,
        p_input_length: params.inputLength ?? null,
        p_latency_ms: params.latencyMs ?? null,
        p_search_count: params.searchCount ?? 0,
        p_ip_address: params.ipAddress ?? null,
        p_user_agent: params.userAgent ?? null,
      });

      if (!rpcResponse.error && rpcResponse.data?.[0]) {
        const result = rpcResponse.data[0];
        if (params.preDeductId && params.credits > 0) {
          await this.applyInvitationRebate(params.credits, params.preDeductId);
        }

        return {
          userMessageId: result.user_message_id ?? null,
          assistantMessageId: result.assistant_message_id ?? null,
          transactionId: result.transaction_id ?? null,
          billingId: result.settle_id ?? null,
          balanceAfter: result.balance_after ?? 0,
          refundedCredits: result.refunded_credits ?? 0,
        };
      }

      if (rpcResponse.error) {
        console.warn('[Billing] atomic_finalize_ai_success unavailable, falling back:', rpcResponse.error.message);
      }
    }

    const messageIds = await this.persistMessages(
      params.conversationId,
      params.userMessage,
      params.assistantMessage,
    );

    let refundedCredits = 0;
    let balanceAfter = await this.getBalance();

    if (params.preDeductId) {
      const settleResult = await this.settle(
        params.preDeductId,
        params.credits,
        params.usage,
        messageIds.assistantMessageId
          ? {
              messageId: messageIds.assistantMessageId,
              conversationId: params.conversationId,
              content: params.assistantMessage,
            }
          : undefined,
      );
      refundedCredits = Math.max(0, settleResult.difference);
      balanceAfter = settleResult.balanceAfter;
    }

    await this.recordTokenStats({
      conversationId: params.conversationId,
      messageId: messageIds.assistantMessageId ?? undefined,
      modelUsed: params.modelUsed,
      usage: params.usage,
      costUsd: params.costUsd,
      credits: params.credits,
      searchCount: params.searchCount ?? 0,
      metadata: params.tokenMetadata,
    });

    await this.recordUsageLog({
      conversationId: params.conversationId,
      requestId,
      modelId: params.modelUsed,
      status: 'success',
      inputLength: params.inputLength,
      latencyMs: params.latencyMs,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: params.usageMetadata,
    });

    return {
      userMessageId: messageIds.userMessageId,
      assistantMessageId: messageIds.assistantMessageId,
      transactionId: null,
      billingId: null,
      balanceAfter,
      refundedCredits,
    };
  }

  async finalizeAIFailure(params: FinalizeAIFailureParams): Promise<RefundResult> {
    const requestId = normalizeRequestId(params.requestId);
    const rpcFn = (this.supabase as { rpc?: Function }).rpc;
    if (typeof rpcFn === 'function') {
      const rpcResponse = await rpcFn.call(this.supabase, 'atomic_finalize_ai_failure', {
        p_user_id: this.userId,
        p_model_used: params.modelUsed,
        p_reason: params.reason,
        p_pre_deduct_id: params.preDeductId ?? null,
        p_conversation_id: params.conversationId ?? null,
        p_request_id: requestId ?? null,
        p_input_length: params.inputLength ?? null,
        p_latency_ms: params.latencyMs ?? null,
        p_ip_address: params.ipAddress ?? null,
        p_user_agent: params.userAgent ?? null,
        p_usage_metadata: params.usageMetadata ?? {},
      });

      if (!rpcResponse.error && rpcResponse.data?.[0]) {
        return {
          refundAmount: rpcResponse.data[0].refund_amount ?? 0,
          balanceAfter: rpcResponse.data[0].balance_after ?? 0,
        };
      }

      if (rpcResponse.error) {
        console.warn('[Billing] atomic_finalize_ai_failure unavailable, falling back:', rpcResponse.error.message);
      }
    }

    let refundResult: RefundResult = { refundAmount: 0, balanceAfter: await this.getBalance() };
    if (params.preDeductId) {
      refundResult = await this.refund(params.preDeductId, params.reason);
    }

    await this.recordUsageLog({
      conversationId: params.conversationId,
      requestId,
      modelId: params.modelUsed,
      status: 'failed',
      errorMessage: params.reason,
      inputLength: params.inputLength,
      latencyMs: params.latencyMs,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: params.usageMetadata,
    });

    return refundResult;
  }

  /**
   * 记录 Token 统计
   */
  async recordTokenStats(params: {
    conversationId: string;
    messageId?: string;
    modelUsed: string;
    usage: TokenUsage;
    costUsd: number;
    credits: number;
    searchCount?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.supabase
      .from('token_stats')
      .insert({
        conversation_id: params.conversationId,
        user_id: this.userId,
        message_id: params.messageId,
        model_used: params.modelUsed,
        input_tokens: params.usage.inputTokens,
        output_tokens: params.usage.outputTokens,
        cached_tokens: params.usage.cacheReadTokens ?? 0,
        cache_creation_tokens: params.usage.cacheCreationTokens ?? 0,
        web_search_count: params.searchCount ?? 0,
        total_cost_usd: params.costUsd.toFixed(6),
        total_credits: params.credits,
        metadata: params.metadata ?? {},
      });

    if (error) {
      console.error('Failed to record token stats:', error);
    }
  }

  /**
   * 记录 AI 使用日志
   */
  async recordUsageLog(params: {
    conversationId?: string;
    requestId?: string;
    modelId: string;
    status: 'success' | 'failed' | 'timeout' | 'rate_limited' | 'moderation_blocked';
    errorMessage?: string;
    inputLength?: number;
    latencyMs?: number;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.supabase
      .from('ai_usage_logs')
      .insert({
        user_id: this.userId,
        conversation_id: params.conversationId,
        request_id: params.requestId,
        model_id: params.modelId,
        status: params.status,
        error_message: params.errorMessage,
        input_length: params.inputLength,
        latency_ms: params.latencyMs,
        ip_address: params.ipAddress,
        user_agent: params.userAgent,
        metadata: params.metadata,
      });

    if (error) {
      console.error('Failed to record usage log:', error);
    }
  }
}

export default BillingService;
