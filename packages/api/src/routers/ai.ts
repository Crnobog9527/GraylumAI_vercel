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
  BillingService,
  calculateTokenCostWithPricing,
  estimateRequestCost,
  getModelPricing,
} from '../services/billing';
import { selectModel, getAvailableModels } from '../services/modelRouter';
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
    console.error('Failed to save user message:', userError);
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
    console.error('Failed to save assistant message:', assistantError);
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
    .eq('id', conversationId);
}

/**
 * 调用 Claude API
 * 注意: 这是一个简化版本，实际实现将在 Phase 9.3 中完善
 */
async function callClaudeAPI(params: {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
}): Promise<{
  content: string;
  usage: TokenUsage;
  stopReason: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'AI 服务未配置',
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.systemPrompt,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Claude API error:', errorText);

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
    content: Array<{ type: string; text: string }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason: string;
  };

  const content = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  return {
    content,
    usage: {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
    },
    stopReason: data.stop_reason,
  };
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
        supabase: ctx.supabase,
        userId: ctx.profileId,
      });

      // 0. 幂等性检查 - 如果请求已完成，直接返回缓存结果
      const idempotencyCheck = await billingService.checkIdempotency(requestId);
      if (idempotencyCheck.exists && idempotencyCheck.result) {
        console.log(`[Idempotency] Returning cached response for request ${requestId}`);
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
            usage: { inputTokens: 0, outputTokens: 0 },
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

      // 5. 估算成本
      const estimatedInputTokens = estimateTokensFromString(input.message) +
        history.reduce((sum, m) => sum + estimateTokensFromString(m.content), 0);
      const estimatedCost = estimateRequestCost(
        modelConfig.modelId,
        estimatedInputTokens
      );

      // 6. 安全检查 (包括余额)
      await preAICallSecurityChecks(
        { supabase: ctx.supabase, userId: ctx.profileId },
        estimatedCost
      );

      // 7. 预扣积分 (带幂等性 Key)
      const preDeductResult = await billingService.preDeduct(estimatedCost, { requestId });

      try {
        // 8. 构建消息
        const messages = [
          ...history,
          { role: 'user' as const, content: input.message },
        ];

        // 9. 调用 AI
        const aiResponse = await callClaudeAPI({
          model: modelConfig.modelId,
          messages,
          maxTokens: modelConfig.maxTokens,
        });

        // 10. 保存消息
        const savedMessages = await saveMessages(
          ctx.supabase,
          conversation.id,
          input.message,
          aiResponse.content
        );

        // 11. 如果是新对话，更新标题
        if (conversation.isNew) {
          await updateConversationTitle(
            ctx.supabase,
            conversation.id,
            input.message
          );
        }

        // 12. 计算实际成本 (使用数据库动态定价)
        const pricing = await getModelPricing(ctx.supabase, modelConfig.modelId);
        const { credits: actualCredits, costUsd, breakdown } = calculateTokenCostWithPricing(
          aiResponse.usage,
          pricing
        );

        // 13. 结算 (包含响应信息用于幂等性缓存)
        await billingService.settle(
          preDeductResult.preDeductId,
          actualCredits,
          aiResponse.usage,
          {
            messageId: savedMessages.assistantMessageId,
            conversationId: conversation.id,
            content: aiResponse.content,
          }
        );

        // 14. 记录统计
        await billingService.recordTokenStats({
          conversationId: conversation.id,
          messageId: savedMessages.assistantMessageId,
          modelUsed: modelConfig.modelId,
          usage: aiResponse.usage,
          costUsd,
          credits: actualCredits,
        });

        // 15. 记录使用日志 (P1-9: 补全日志信息)
        const latencyMs = Date.now() - startTime;
        // 从请求头获取 IP 和 User-Agent
        const ipAddress = ctx.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim()
          ?? ctx.headers?.get?.('x-real-ip')
          ?? ctx.req?.ip
          ?? 'unknown';
        const userAgent = ctx.headers?.get?.('user-agent') ?? 'unknown';

        await billingService.recordUsageLog({
          conversationId: conversation.id,
          requestId, // P1-9: 添加 request_id
          modelId: modelConfig.modelId,
          status: 'success',
          inputLength: input.message.length,
          latencyMs,
          ipAddress, // P1-9: 添加 IP 地址
          userAgent, // P1-9: 添加 User-Agent
          metadata: { routingReason },
        });

        // 16. 返回响应
        return {
          messageId: savedMessages.assistantMessageId,
          conversationId: conversation.id,
          content: aiResponse.content,
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
        // 失败退费
        await billingService.refund(
          preDeductResult.preDeductId,
          error instanceof Error ? error.message : 'AI 调用失败'
        );

        // 记录失败日志 (P1-9: 补全日志信息)
        const failLatencyMs = Date.now() - startTime;
        const failIpAddress = ctx.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim()
          ?? ctx.headers?.get?.('x-real-ip')
          ?? ctx.req?.ip
          ?? 'unknown';
        const failUserAgent = ctx.headers?.get?.('user-agent') ?? 'unknown';

        await billingService.recordUsageLog({
          conversationId: conversation.id,
          requestId, // P1-9: 添加 request_id
          modelId: modelConfig.modelId,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          inputLength: input.message.length,
          latencyMs: failLatencyMs,
          ipAddress: failIpAddress, // P1-9: 添加 IP 地址
          userAgent: failUserAgent, // P1-9: 添加 User-Agent
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
        supabase: ctx.supabase,
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
          },
        });

        return {
          success: true,
          consumedCredits: result.consumedCredits,
          refundedCredits: result.refundedCredits,
          balanceAfter: result.balanceAfter,
        };
      } catch (error) {
        console.error('Abort request failed:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : '中断结算失败',
        });
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

      // 估算成本
      const estimatedCost = estimateRequestCost(
        modelConfig.modelId,
        totalInputTokens
      );

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
