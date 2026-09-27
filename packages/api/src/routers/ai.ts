import { parseProviderUsage } from '../services/providerUsage';
/**
 * AI Router - AI 对话核心路由
 *
 * 提供 AI 对话的主要 tRPC 端点
 * 包括: 发送消息、流式响应、对话管理
 */

import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type TokenUsage } from '../types/ai';
import {
  BillingService,
  calculateTokenCostWithPricing,
  estimatePreDeductCredits,
  getBillingRuntimeSettings,
  getModelPricing,
  logger,
} from '../services';
import { selectModel, getAvailableModels } from '../services/modelRouter';
import {
  getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders,
  normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi,
} from '../services/providerUtils';
import { estimateTokensFromString } from '../services/tokenCounter';

// ============================================
// 辅助函数
// ============================================

/**
 * 获取对话历史
 */
async function getConversationHistory(
  supabase: any,
  conversationId: string,
  limit: number = 20
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { data: messages } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);

  return messages ?? [];
}

/**
 * 保存消息
 */
async function saveMessages(
  supabase: any,
  conversationId: string,
  userMessage: string,
  assistantMessage: string
): Promise<{ userMessageId: string; assistantMessageId: string }> {
  // 保存用户消息
  const { data: userMsg, error: userError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'user',
      content: userMessage,
    })
    .select('id')
    .single();

  if (userError) {
    logger.error('ai', 'ai_user_message_save_failed', {
      code: userError.code,
    });
  }

  // 保存助手消息
  const { data: assistantMsg, error: assistantError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: assistantMessage,
    })
    .select('id')
    .single();

  if (assistantError) {
    logger.error('ai', 'ai_assistant_message_save_failed', {
      code: assistantError.code,
    });
  }

  return {
    userMessageId: userMsg?.id ?? '',
    assistantMessageId: assistantMsg?.id ?? '',
  };
}

/**
 * 调用 Claude via OpenRouter / OpenAI-compatible API.
 * Anthropic 官方 API 已退役，不再作为运行时 fallback。
 */
export async function callClaudeViaOpenRouter(params: {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  apiKey?: string | null;
  apiEndpoint?: string | null;
}): Promise<{
  content: string;
  usage: TokenUsage;
  usageEvidence: ReturnType<typeof parseProviderUsage>['evidence'];
  stopReason: string;
}> {
  const apiKey = getConfiguredProviderApiKey(params.apiKey);

  if (!apiKey) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'AI 服务未配置',
    });
  }

  const endpoint = usesOpenAICompatibleApi({
    endpoint: params.apiEndpoint,
    apiKey,
  })
    ? (normalizeOpenAICompatibleEndpoint(params.apiEndpoint) || 'https://openrouter.ai/api/v1/chat/completions')
    : null;

  if (!endpoint) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'AI 服务未配置 OpenRouter 兼容 endpoint',
    });
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: getOpenAICompatibleHeaders(apiKey),
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: [
        ...(params.systemPrompt ? [{ role: 'system', content: params.systemPrompt }] : []),
        ...params.messages,
      ],
    }),
  });

  if (!response.ok) {
    logger.error('ai', 'ai_provider_request_failed', {
      provider: 'openrouter',
      status: response.status,
    });

    if (response.status === 429) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'AI 服务繁忙，请稍后重试',
      });
    }

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'AI 服务调用失败',
    });
  }

  const data = await response.json() as {
    error?: unknown;
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };

  if (data.error) throw new Error('PROVIDER_STREAM_FAILED');
  const messageContent = data.choices?.[0]?.message?.content;
  const content = Array.isArray(messageContent)
    ? messageContent.map((part) => part.text ?? '').join('')
    : (messageContent ?? '');
  const finishReason = data.choices?.[0]?.finish_reason;

  const accounting = parseProviderUsage(data.usage);
  return {
    content,
    usage: accounting.usage,
    usageEvidence: accounting.evidence,
    stopReason: finishReason === 'length'
      ? 'max_tokens'
      : finishReason === 'tool_calls'
        ? 'tool_use'
        : 'end_turn',
  };
}

const AI_BILLING_UNAVAILABLE_MESSAGE = 'AI 计费服务暂不可用，请稍后重试';
const AI_SEND_MESSAGE_CLOSED_MESSAGE = 'ai.sendMessage 已关闭，请使用 /api/ai/stream + useStreamingChat。';

function assertAiBillingAdminPrivileges(hasSupabaseAdminPrivileges: boolean) {
  if (hasSupabaseAdminPrivileges) {
    return;
  }

  throw new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: AI_BILLING_UNAVAILABLE_MESSAGE,
  });
}

// ============================================
// AI Router
// ============================================

export const aiRouter = router({
  /**
   * @deprecated 旧非流式对话入口，已关闭（P0-2）：没有调用方，却会预扣积分并调用模型供应商。
   * 鉴权通过后立即拒绝，不做任何计费或供应商调用。请使用 /api/ai/stream + useStreamingChat。
   */
  sendMessage: protectedProcedure
    .mutation(async () => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: AI_SEND_MESSAGE_CLOSED_MESSAGE,
      });
    }),

  /**
   * 中断请求并结算已消耗的 tokens
   * 用于流式响应被用户中断时的计费结算
   */
  abortRequest: protectedProcedure
    .input(z.object({
      requestId: z.string().uuid(),
      preDeductId: z.string().uuid(),
      consumedTokens: z.object({
        inputTokens: z.number().min(0),
        outputTokens: z.number().min(0),
      }),
      modelId: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx }) => {
      assertAiBillingAdminPrivileges(ctx.hasSupabaseAdminPrivileges);
      // Browser counts are untrusted and cannot settle or refund a reservation.
      // The active server request owns settlement from provider usage.
      throw new TRPCError({code:'PRECONDITION_FAILED',message:'用量由服务端核算，不能使用客户端上报的 Token 数量结算。'});

    }),

  /**
   * 估算消息成本 (不实际调用 AI)
   */
  estimateCost: protectedProcedure
    .input(z.object({
      message: z.string(),
      conversationId: z.string().uuid().optional(),
      modelId: z.string().uuid().optional(),
    }))
    .query(async ({ ctx, input }) => {
      // 获取对话历史长度
      let historyTokens = 0;
      if (input.conversationId) {
        const history = await getConversationHistory(ctx.supabase, input.conversationId);
        historyTokens = history.reduce(
          (sum, m) => sum + estimateTokensFromString(m.content),
          0
        );
      }

      // 估算输入 tokens
      const messageTokens = estimateTokensFromString(input.message);
      const totalInputTokens = messageTokens + historyTokens;

      // 获取模型配置
      const { modelConfig } = await selectModel({
        supabase: ctx.supabase,
        conversationId: input.conversationId,
        message: input.message,
        conversationTurns: 0,
        userPreferredModel: input.modelId,
      });

      const billingRuntimeSettings = await getBillingRuntimeSettings(ctx.supabase);
      const pricing = await getModelPricing(ctx.supabase, modelConfig.modelId, {
        requireModelPricing: billingRuntimeSettings.requireModelPricing,
      });
      const estimatedCostResult = calculateTokenCostWithPricing(
        {
          inputTokens: totalInputTokens,
          outputTokens: 4096,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        pricing,
        {},
        billingRuntimeSettings,
      );
      const estimatedCost = estimatePreDeductCredits(estimatedCostResult.credits, billingRuntimeSettings);

      // 获取用户余额
      const billingService = new BillingService({
        supabase: ctx.supabase,
        userId: ctx.profileId,
      });
      const balance = await billingService.getBalance();

      return {
        estimatedCredits: estimatedCost,
        estimatedInputTokens: totalInputTokens,
        modelName: modelConfig.name,
        modelId: modelConfig.modelId,
        currentBalance: balance,
        sufficient: balance >= estimatedCost,
      };
    }),

  /**
   * 获取可用模型列表
   */
  getAvailableModels: protectedProcedure
    .query(async ({ ctx }) => {
      const models = await getAvailableModels(ctx.supabase);
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        modelId: m.modelId,
        provider: m.provider,
        maxTokens: m.maxTokens,
        enableWebSearch: m.enableWebSearch,
      }));
    }),

  /**
   * 获取对话历史
   */
  getConversationMessages: protectedProcedure
    .input(z.object({
      conversationId: z.string().uuid(),
      limit: z.number().min(1).max(100).optional().default(50),
    }))
    .query(async ({ ctx, input }) => {
      // 验证对话属于当前用户
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .single();

      if (!conversation) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '对话不存在',
        });
      }

      const { data: messages } = await ctx.supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', input.conversationId)
        .order('created_at', { ascending: true })
        .limit(input.limit);

      return messages ?? [];
    }),

  /**
   * 获取 Token 使用统计
   */
  getTokenStats: protectedProcedure
    .input(z.object({
      period: z.enum(['day', 'week', 'month']).default('week'),
    }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      let startDate: Date;

      switch (input.period) {
        case 'day':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      const { data: stats } = await ctx.supabase
        .from('token_stats')
        .select('input_tokens, output_tokens, cached_tokens, total_credits, total_cost_usd, model_used')
        .eq('user_id', ctx.profileId)
        .gte('created_at', startDate.toISOString());

      if (!stats || stats.length === 0) {
        return {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedTokens: 0,
          totalCredits: 0,
          totalCostUsd: 0,
          requestCount: 0,
          cacheHitRate: 0,
          modelBreakdown: [],
        };
      }

      // 汇总统计
      const summary = stats.reduce(
        (acc, s) => ({
          inputTokens: acc.inputTokens + (s.input_tokens ?? 0),
          outputTokens: acc.outputTokens + (s.output_tokens ?? 0),
          cachedTokens: acc.cachedTokens + (s.cached_tokens ?? 0),
          credits: acc.credits + (s.total_credits ?? 0),
          costUsd: acc.costUsd + parseFloat(s.total_cost_usd ?? '0'),
        }),
        { inputTokens: 0, outputTokens: 0, cachedTokens: 0, credits: 0, costUsd: 0 }
      );

      // 模型分布
      const modelMap = new Map<string, { count: number; credits: number }>();
      for (const s of stats) {
        const existing = modelMap.get(s.model_used) ?? { count: 0, credits: 0 };
        modelMap.set(s.model_used, {
          count: existing.count + 1,
          credits: existing.credits + (s.total_credits ?? 0),
        });
      }

      const modelBreakdown = Array.from(modelMap.entries()).map(([model, data]) => ({
        model,
        count: data.count,
        credits: data.credits,
        percentage: Math.round((data.credits / summary.credits) * 100),
      }));

      // 缓存命中率
      const totalInputWithoutCache = summary.inputTokens + summary.cachedTokens;
      const cacheHitRate = totalInputWithoutCache > 0
        ? summary.cachedTokens / totalInputWithoutCache
        : 0;

      return {
        totalInputTokens: summary.inputTokens,
        totalOutputTokens: summary.outputTokens,
        totalCachedTokens: summary.cachedTokens,
        totalCredits: summary.credits,
        totalCostUsd: summary.costUsd,
        requestCount: stats.length,
        cacheHitRate: Math.round(cacheHitRate * 100),
        modelBreakdown,
      };
    }),
});

export default aiRouter;
