/**
 * Billing Service - 原子化计费服务
 *
 * 实现三段式计费: 预扣 → 结算 → 退费
 * 确保计费事务的原子性和一致性
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type TokenUsage,
  type CostBreakdown,
  BILLING_CONSTANTS,
  MODEL_PRICING,
  type SupportedModelId,
  InsufficientCreditsError,
  BillingNotFoundError,
  InvalidBillingOperationError,
} from '../types/billing';

// ============================================
// 类型定义
// ============================================

export interface PreDeductResult {
  preDeductId: string;
  estimatedCredits: number;
  balanceBefore: number;
  balanceAfter: number;
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

export interface BillingContext {
  supabase: SupabaseClient;
  userId: string;
}

// ============================================
// 成本计算工具
// ============================================

/**
 * 计算 Token 成本 (积分)
 */
export function calculateTokenCost(
  modelId: string,
  usage: TokenUsage
): { credits: number; costUsd: number; breakdown: CostBreakdown } {
  // 获取模型定价
  const pricing = MODEL_PRICING[modelId as SupportedModelId] ?? MODEL_PRICING['claude-sonnet-4-20250514'];

  // 计算各项成本 (美元)
  const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const cacheWriteCostUsd = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * (pricing.cacheWritePer1M ?? 0);
  const cacheReadCostUsd = ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheReadPer1M ?? 0);
  const searchCostUsd = 0; // Web search cost would be calculated separately

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
    search: 0,
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
   * 预扣积分 (请求开始前)
   *
   * @param estimatedCredits - 预估需要的积分
   * @param reason - 预扣原因
   * @returns 预扣记录 ID 和相关信息
   */
  async preDeduct(estimatedCredits: number, reason: string = 'AI 对话预扣'): Promise<PreDeductResult> {
    // 1. 获取当前余额并加锁 (使用 Supabase RPC 或乐观锁)
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

    // 4. 记录预扣历史
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
        },
      })
      .select('id')
      .single();

    if (billingError || !billingRecord) {
      // 预扣成功但记录失败，需要告警
      console.error('Failed to record pre-deduct:', billingError);
      throw new Error('计费记录失败');
    }

    return {
      preDeductId: billingRecord.id,
      estimatedCredits,
      balanceBefore: currentCredits,
      balanceAfter: newCredits,
    };
  }

  /**
   * 结算 (请求完成后)
   *
   * @param preDeductId - 预扣记录 ID
   * @param actualCredits - 实际消耗的积分
   * @param usage - Token 使用详情
   */
  async settle(
    preDeductId: string,
    actualCredits: number,
    usage: TokenUsage
  ): Promise<SettleResult> {
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

    // 3. 记录结算
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

    return {
      actualCredits,
      difference,
      balanceAfter: finalProfile?.credits ?? 0,
    };
  }

  /**
   * 退费 (请求失败时)
   *
   * @param preDeductId - 预扣记录 ID
   * @param reason - 退费原因
   */
  async refund(preDeductId: string, reason: string): Promise<RefundResult> {
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

    return {
      refundAmount,
      balanceAfter: newCredits,
    };
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
        web_search_count: 0,
        total_cost_usd: params.costUsd.toFixed(6),
        total_credits: params.credits,
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
