/**
 * AI Router - AI 对话核心路由
 *
 * 提供 AI 对话的主要 tRPC 端点
 * 包括: 发送消息、流式响应、对话管理
 */

import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createSafeInternalError } from '../lib/publicError';
import {
  AIRequestSchema,
  type AIResponse,
  type TokenUsage,
} from '../types/ai';
import {
  preAICallSecurityChecks,
  checkInputSecurity,
} from '../middleware/securityChecks';
import {
  filterAIOutput,
  BillingService,
  ModelPricingUnavailableError,
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
import { countTokens, estimateTokensFromString } from '../services/tokenCounter';

// ============================================
// 辅助函数
// ============================================

/**
 * 获取或创建对话
 */
async function getOrCreateConversation(
  supabase: any,
  userId: string,
  conversationId?: string,
  title?: string
): Promise<{ id: string; isNew: boolean }> {
  if (conversationId) {
    // 验证对话存在且属于当前用户
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (existing) {
      return { id: existing.id, isNew: false };
    }
  }

  // 创建新对话
  const { data: newConversation, error } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      title: title ?? '新对话',
    })
    .select('id')
    .single();

  if (error || !newConversation) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '创建对话失败',
    });
  }

  return { id: newConversation.id, isNew: true };
}

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
 * 更新对话标题 (如果是新对话)
 */
async function updateConversationTitle(
  supabase: any,
  conversationId: string,
  firstMessage: string
): Promise<void> {
  // 取消息前 50 个字符作为标题
  const title = firstMessage.length > 50
    ? firstMessage.substring(0, 47) + '...'
    : firstMessage;

  await supabase
    .from('conversations')
    .update({ title })
    .eq('id', conversationId)
    .eq('title', '新对话');
}

/**
 * 调用 Claude via OpenRouter / OpenAI-compatible API.
 * Anthropic 官方 API 已退役，不再作为运行时 fallback。
 */
async function callClaudeViaOpenRouter(params: {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  apiKey?: string | null;
  apiEndpoint?: string | null;
}): Promise<{
  content: string;
  usage: TokenUsage;
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

  const messageContent = data.choices?.[0]?.message?.content;
  const content = Array.isArray(messageContent)
    ? messageContent.map((part) => part.text ?? '').join('')
    : (messageContent ?? '');
  const finishReason = data.choices?.[0]?.finish_reason;

  return {
    content,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    stopReason: finishReason === 'length'
      ? 'max_tokens'
      : finishReason === 'tool_calls'
        ? 'tool_use'
        : 'end_turn',
  };
}

function getTokenCounterProvider(model: {
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';
  tokenCountingMethod?: string;
}): 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin' {
  if (model.tokenCountingMethod === 'anthropic_count_tokens') return 'anthropic';
  if (model.tokenCountingMethod === 'gemini_count_tokens') return 'google';
  if (model.tokenCountingMethod === 'verified_openai_tokenizer') return 'openai';
  return model.provider;
}

// ============================================
// AI Router
// ============================================

export const aiRouter = router({
  /**
   * 发送消息 (非流式)
   */
  sendMessage: protectedProcedure
    .input(AIRequestSchema)
    .mutation(async ({ ctx, input }): Promise<AIResponse> => {
      const startTime = Date.now();
      // 生成或使用客户端提供的 requestId (用于幂等性)
      const requestId = input.requestId ?? randomUUID();
      const billingService = new BillingService({
        supabase: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      // 0. 幂等性检查 - 如果请求已完成，直接返回缓存结果
      const idempotencyCheck = await billingService.checkIdempotency(requestId);
      if (idempotencyCheck.exists && idempotencyCheck.result) {
        // 获取完整的缓存响应
        const { data: cachedResponse } = await ctx.supabase
          .from('messages')
          .select('id, content, created_at')
          .eq('id', idempotencyCheck.result.messageId)
          .single();

        if (cachedResponse) {
          return {
            messageId: cachedResponse.id,
            conversationId: idempotencyCheck.result.conversationId,
            content: cachedResponse.content,
            modelUsed: 'cached',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            cost: { creditsDeducted: 0, costUsd: 0, costBreakdown: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, search: 0, total: 0 } },
            stopReason: 'end_turn',
            createdAt: cachedResponse.created_at,
          };
        }
      }

      // 1. 输入安全检查
      checkInputSecurity(input.message);

      // 2. 获取/创建对话
      const conversation = await getOrCreateConversation(
        ctx.supabase,
        ctx.profileId,
        input.conversationId
      );

      // 3. 获取对话历史
      const history = await getConversationHistory(ctx.supabase, conversation.id);
      const conversationTurns = history.length;

      // 4. 模型路由
      const { modelConfig, routingReason } = await selectModel({
        supabase: ctx.supabase,
        conversationId: conversation.id,
        message: input.message,
        conversationTurns,
        userPreferredModel: input.modelId,
      });

      if (!modelConfig.tokenCountingSupported) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'AI 服务暂时不可用，请稍后重试',
        });
      }

      // 5. 估算成本
      const countedInput = await countTokens({
        model: modelConfig.modelId,
        provider: getTokenCounterProvider(modelConfig),
        apiKey: modelConfig.apiKey,
        apiEndpoint: modelConfig.apiEndpoint,
        tokenizerFamily: modelConfig.tokenizerFamily,
        messages: [
          ...history,
          { role: 'user', content: input.message },
        ],
      }, {
        useOfficial: modelConfig.tokenCountingMethod !== 'provider_usage',
        fallbackToEstimate: true,
      });
      const estimatedInputTokens = countedInput.inputTokens;
      const billingRuntimeSettings = await getBillingRuntimeSettings(ctx.supabase);
      let pricing: Awaited<ReturnType<typeof getModelPricing>>;
      try {
        pricing = await getModelPricing(ctx.supabase, modelConfig.modelId, {
          requireModelPricing: billingRuntimeSettings.requireModelPricing,
        });
      } catch (error) {
        if (error instanceof ModelPricingUnavailableError) {
          logger.warn('billing', 'ai_send_model_pricing_unavailable', {
            modelId: modelConfig.modelId,
            reason: error.reason,
          });
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: '模型计费价格未配置，请联系管理员',
          });
        }
        throw error;
      }
      const estimatedUsage: TokenUsage = {
        inputTokens: estimatedInputTokens,
        outputTokens: 4096,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      const estimatedCostResult = calculateTokenCostWithPricing(
        estimatedUsage,
        pricing,
        {},
        billingRuntimeSettings,
      );
      const estimatedCost = estimatePreDeductCredits(estimatedCostResult.credits, billingRuntimeSettings);

      // 6. 安全检查 (包括余额)
      await preAICallSecurityChecks(
        { supabase: ctx.supabase, userId: ctx.profileId },
        estimatedCost
      );

      // 7. 预扣积分 (带幂等性 Key)
      const preDeductResult = await billingService.preDeduct(estimatedCost, { requestId });

      // 记录 AI 调用开始日志
      logger.ai.callStart(
        modelConfig.modelId,
        estimatedInputTokens,
        conversation.id,
        requestId,
        { userId: ctx.profileId }
      );

      try {
        // 8. 构建消息
        const messages = [
          ...history,
          { role: 'user' as const, content: input.message },
        ];

        // 9. 调用 AI
        const aiResponse = await callClaudeViaOpenRouter({
          model: modelConfig.modelId,
          messages,
          maxTokens: modelConfig.maxTokens,
          apiKey: modelConfig.apiKey,
          apiEndpoint: modelConfig.apiEndpoint,
        });

        // 9.5. 输出安全检查 (P1-4: 应用输出安全过滤)
        const filteredOutput = filterAIOutput(aiResponse.content);
        if (filteredOutput.blocked || filteredOutput.sanitized) {
          logger.security.contentBlocked(
            ctx.profileId,
            filteredOutput.reasons.join(',') || 'output_filtered',
            'output',
            { requestId, conversationId: conversation.id }
          );
        }

        const { credits: actualCredits, costUsd, breakdown } = calculateTokenCostWithPricing(
          aiResponse.usage,
          pricing,
          {},
          billingRuntimeSettings,
        );
        const pricingMetadata = {
          inputPer1M: pricing.inputPer1M,
          outputPer1M: pricing.outputPer1M,
          searchPer1K: pricing.searchPer1K ?? 0,
          pricingSource: 'ai_models',
          modelId: modelConfig.modelId,
        };

        // 11. 原子化写消息、记账和统计
        const latencyMs = Date.now() - startTime;
        const ipAddress = ctx.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim()
          ?? ctx.headers?.get?.('x-real-ip')
          ?? 'unknown';
        const userAgent = ctx.headers?.get?.('user-agent') ?? 'unknown';
        const finalizeResult = await billingService.finalizeAISuccess({
          conversationId: conversation.id,
          userMessage: input.message,
          assistantMessage: filteredOutput.content,
          modelUsed: modelConfig.modelId,
          usage: aiResponse.usage,
          costUsd,
          credits: actualCredits,
          preDeductId: preDeductResult.preDeductId,
          requestId,
          inputLength: input.message.length,
          latencyMs,
          ipAddress,
          userAgent,
          tokenMetadata: {
            count_method: modelConfig.tokenCountingMethod ?? countedInput.method,
            count_source: countedInput.countSource,
            counter_version: countedInput.counterVersion,
            pricing: pricingMetadata,
            billingSettingsSnapshot: {
              creditsPerUsd: billingRuntimeSettings.creditsPerUsd,
              tokenPriceMultiplier: billingRuntimeSettings.tokenPriceMultiplier,
              minPreDeduct: billingRuntimeSettings.minPreDeduct,
              maxPreDeduct: billingRuntimeSettings.maxPreDeduct,
              safetyMargin: billingRuntimeSettings.safetyMargin,
            },
          },
          usageMetadata: {
            routingReason,
            pricing: pricingMetadata,
            billingSettingsSnapshot: {
              creditsPerUsd: billingRuntimeSettings.creditsPerUsd,
              tokenPriceMultiplier: billingRuntimeSettings.tokenPriceMultiplier,
              minPreDeduct: billingRuntimeSettings.minPreDeduct,
              maxPreDeduct: billingRuntimeSettings.maxPreDeduct,
              safetyMargin: billingRuntimeSettings.safetyMargin,
            },
          },
        });

        // 12. 如果是新对话，更新标题
        if (conversation.isNew) {
          await updateConversationTitle(
            ctx.supabase,
            conversation.id,
            input.message
          );
        }

        // 13. 记录 AI 调用完成日志
        logger.ai.callComplete(
          modelConfig.modelId,
          aiResponse.usage.inputTokens,
          aiResponse.usage.outputTokens,
          latencyMs,
          actualCredits,
          requestId,
          { userId: ctx.profileId, conversationId: conversation.id }
        );

        // 14. 返回响应
        return {
          messageId: finalizeResult.assistantMessageId ?? '',
          conversationId: conversation.id,
          content: filteredOutput.content,
          modelUsed: modelConfig.modelId,
          usage: aiResponse.usage,
          cost: {
            creditsDeducted: actualCredits,
            costUsd,
            costBreakdown: breakdown,
          },
          stopReason: aiResponse.stopReason as AIResponse['stopReason'],
          createdAt: new Date().toISOString(),
        };
      } catch (error) {
        // 记录 AI 调用失败日志
        const failLatencyMs = Date.now() - startTime;
        logger.ai.callFailed(
          modelConfig.modelId,
          'AI 调用失败，请查看服务端日志',
          0,
          requestId,
          { userId: ctx.profileId, conversationId: conversation.id }
        );

        const failIpAddress = ctx.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim()
          ?? ctx.headers?.get?.('x-real-ip')
          ?? 'unknown';
        const failUserAgent = ctx.headers?.get?.('user-agent') ?? 'unknown';

        await billingService.finalizeAIFailure({
          conversationId: conversation.id,
          requestId,
          modelUsed: modelConfig.modelId,
          reason: 'AI 调用失败，请查看服务端日志',
          preDeductId: preDeductResult.preDeductId,
          inputLength: input.message.length,
          latencyMs: failLatencyMs,
          ipAddress: failIpAddress,
          userAgent: failUserAgent,
          usageMetadata: { routingReason },
        });

        throw error;
      }
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
    .mutation(async ({ ctx, input }) => {
      const billingService = new BillingService({
        supabase: ctx.supabaseAdmin,
        userId: ctx.profileId,
      });

      try {
        const result = await billingService.settleAbort(
          input.preDeductId,
          input.consumedTokens,
          input.modelId,
          input.reason ?? '用户中断'
        );

        // 记录中断日志
        await billingService.recordUsageLog({
          requestId: input.requestId,
          modelId: input.modelId,
          status: 'failed',
          errorMessage: input.reason ?? '用户中断',
          metadata: {
            aborted: true,
            consumedTokens: input.consumedTokens,
            refundedCredits: result.refundedCredits,
            pricing: result.pricing,
            billingSettingsSnapshot: result.billingSettingsSnapshot,
          },
        });

        return {
          success: true,
          consumedCredits: result.consumedCredits,
          refundedCredits: result.refundedCredits,
          balanceAfter: result.balanceAfter,
        };
      } catch (error) {
        logger.error('ai', 'ai_abort_settle_failed');
        throw createSafeInternalError(error, '中断结算失败，请稍后重试');
      }
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
