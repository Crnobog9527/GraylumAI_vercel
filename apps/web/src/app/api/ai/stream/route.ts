/**
 * AI Streaming API Route
 *
 * This is the production chat runtime used by the web app. It shares the
 * same runtime settings, prompt resolution, model routing, and provider
 * detection logic as the admin tools and diagnostics surface.
 */

import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from '@/lib/rateLimit';
import { BillingService } from '@repo/api/src/services/billing';
import { buildCachedPrompt } from '@repo/api/src/services/promptCacheBuilder';
import { needsRealtimeData, selectModel } from '@repo/api/src/services/modelRouter';
import {
  applyUserPromptTemplate,
  buildRuntimeSystemPrompt,
  getChatRuntimeSettings,
  resolveActiveChatPrompt,
} from '@repo/api/src/services/chatRuntime';
import {
  getOpenAICompatibleHeaders,
  getProviderErrorMessage,
  normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi,
} from '@repo/api/src/services/providerUtils';
import type { ClaudeMessage } from '@repo/api/src/types/ai';

interface StreamRequest {
  message: string;
  conversationId?: string;
  modelId?: string;
  requestId?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface RuntimeModelConfig {
  id: string;
  modelId: string;
  name: string;
  maxTokens: number;
  inputTokenCost: number;
  outputTokenCost: number;
  apiKey: string | null;
  provider: string;
  apiEndpoint: string | null;
  enableWebSearch: boolean;
}

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function checkOutputSecurity(content: string): boolean {
  const sensitivePatterns = [
    /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /password\s*[:=]\s*["']?[^\s"']{8,}/i,
    /secret\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /sk-[a-zA-Z0-9]{48}/i,
    /sk-ant-[a-zA-Z0-9-_]{95}/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(content)) {
      console.warn('[Security] Detected potential sensitive content in AI output');
      return false;
    }
  }

  return true;
}

async function getOrCreateConversation(
  supabase: any,
  userId: string,
  conversationId?: string,
  title?: string
): Promise<{ id: string; isNew: boolean }> {
  if (conversationId) {
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .eq('is_deleted', 'false')
      .single();

    if (existing) {
      return { id: existing.id, isNew: false };
    }
  }

  const { data: newConversation, error } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      title: title ?? '新对话',
    })
    .select('id')
    .single();

  if (error || !newConversation) {
    throw new Error('创建对话失败');
  }

  return { id: newConversation.id, isNew: true };
}

async function getConversationHistory(
  supabase: any,
  conversationId: string,
  limit: number
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .eq('is_deleted', 'false')
    .order('created_at', { ascending: true })
    .limit(limit);

  return data ?? [];
}

async function getRuntimeModelConfig(
  supabase: any,
  options: {
    runtimeModelId?: string;
    fallbackModelId: string;
    fallbackName: string;
    fallbackProvider: string;
    fallbackMaxTokens: number;
    fallbackInputTokenCost: number;
    fallbackOutputTokenCost: number;
    fallbackEnableWebSearch: boolean;
  }
): Promise<RuntimeModelConfig> {
  if (options.runtimeModelId) {
    const { data } = await supabase
      .from('ai_models')
      .select('id, model_id, name, provider, max_tokens, input_token_cost, output_token_cost, api_key, api_endpoint, enable_web_search')
      .eq('id', options.runtimeModelId)
      .single();

    if (data) {
      return {
        id: data.id,
        modelId: data.model_id,
        name: data.name,
        maxTokens: data.max_tokens,
        inputTokenCost: data.input_token_cost,
        outputTokenCost: data.output_token_cost,
        apiKey: data.api_key || null,
        provider: data.provider || 'anthropic',
        apiEndpoint: data.api_endpoint || null,
        enableWebSearch: data.enable_web_search === 'true',
      };
    }
  }

  return {
    id: options.runtimeModelId ?? 'runtime-default-model',
    modelId: options.fallbackModelId,
    name: options.fallbackName,
    maxTokens: options.fallbackMaxTokens,
    inputTokenCost: options.fallbackInputTokenCost,
    outputTokenCost: options.fallbackOutputTokenCost,
    apiKey: null,
    provider: options.fallbackProvider,
    apiEndpoint: null,
    enableWebSearch: options.fallbackEnableWebSearch,
  };
}

async function saveMessages(
  supabase: any,
  conversationId: string,
  userMessage: string,
  assistantMessage: string
): Promise<{ userMessageId: string | null; assistantMessageId: string | null }> {
  const { data, error } = await supabase
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
    console.error('Failed to save chat messages:', error);
    return { userMessageId: null, assistantMessageId: null };
  }

  return {
    userMessageId: data?.find((item: { role: string }) => item.role === 'user')?.id ?? null,
    assistantMessageId: data?.find((item: { role: string }) => item.role === 'assistant')?.id ?? null,
  };
}

function buildAnthropicPayload(params: {
  modelId: string;
  maxTokens: number;
  messages: ClaudeMessage[];
  systemPrompt?: string;
  enablePromptCache: boolean;
}) {
  const cachedPrompt = buildCachedPrompt({
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    config: { enabled: params.enablePromptCache },
  });

  return {
    payload: {
      model: params.modelId,
      max_tokens: params.maxTokens,
      stream: true,
      messages: cachedPrompt.messages,
      ...(cachedPrompt.system ? { system: cachedPrompt.system } : {}),
    },
    cachePoints: cachedPrompt.cachePoints,
  };
}

function buildOpenAICompatibleMessages(params: {
  systemPrompt?: string;
  messages: ClaudeMessage[];
}) {
  const messages = params.messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n'),
  }));

  if (params.systemPrompt) {
    return [{ role: 'system' as const, content: params.systemPrompt }, ...messages];
  }

  return messages;
}

const MAX_CONTEXT_MESSAGES = 100;

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const body: StreamRequest = await request.json();
    const { conversationId, modelId } = body;
    const message = body.message?.trim();
    const requestId = body.requestId ?? crypto.randomUUID();

    if (!message) {
      return new Response(
        JSON.stringify({ error: '消息内容不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(
        JSON.stringify({ error: '未提供认证 Token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: `身份验证失败: ${authError?.message || '会话已过期'}` }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.id;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const billingService = new BillingService({
      supabase,
      userId,
    });

    const rateLimitResult = await checkRateLimit(userId, 'ai_stream');
    if (!rateLimitResult.success) {
      await billingService.recordUsageLog({
        requestId,
        status: 'rate_limited',
        modelId: 'unknown',
        inputLength: message.length,
        ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
      });

      return new Response(
        JSON.stringify({
          error: '请求过于频繁',
          message: `请在 ${rateLimitResult.retryAfter} 秒后重试`,
          retryAfter: rateLimitResult.retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': rateLimitResult.limit.toString(),
            'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
            'X-RateLimit-Reset': rateLimitResult.reset.toString(),
            'Retry-After': rateLimitResult.retryAfter?.toString() ?? '60',
          },
        }
      );
    }

    const conversation = await getOrCreateConversation(
      supabase,
      userId,
      conversationId,
      message.substring(0, 50)
    );
    const history = await getConversationHistory(supabase, conversation.id, MAX_CONTEXT_MESSAGES);
    const conversationTurns = Math.floor(history.length / 2);
    const runtimeSettings = await getChatRuntimeSettings(supabase);

    const { modelConfig, routingReason } = await selectModel({
      supabase,
      conversationId: conversation.id,
      message,
      conversationTurns,
      userPreferredModel: modelId,
    });

    const activePrompt = await resolveActiveChatPrompt(supabase, {
      platform: 'web',
      modelId: modelConfig.id,
    });
    const systemPrompt = buildRuntimeSystemPrompt(activePrompt);
    const transformedMessage = applyUserPromptTemplate(activePrompt, message);
    const providerMessages: ClaudeMessage[] = [
      ...history,
      { role: 'user', content: transformedMessage },
    ];

    const runtimeModel = await getRuntimeModelConfig(supabase, {
      runtimeModelId: modelConfig.id,
      fallbackModelId: modelConfig.modelId,
      fallbackName: modelConfig.name,
      fallbackProvider: modelConfig.provider,
      fallbackMaxTokens: modelConfig.maxTokens,
      fallbackInputTokenCost: modelConfig.inputTokenCost,
      fallbackOutputTokenCost: modelConfig.outputTokenCost,
      fallbackEnableWebSearch: modelConfig.enableWebSearch,
    });

    const estimatedInputTokens =
      providerMessages.reduce((sum, entry) => sum + estimateTokens(typeof entry.content === 'string'
        ? entry.content
        : entry.content.map((block) => block.text ?? '').join('\n')), 0) +
      estimateTokens(systemPrompt ?? '');
    const estimatedOutputTokens = 1000;
    const estimatedCredits = Math.ceil(
      (estimatedInputTokens * runtimeModel.inputTokenCost +
        estimatedOutputTokens * runtimeModel.outputTokenCost) /
      1000000
    );

    const balance = await billingService.getBalance();
    if (balance < estimatedCredits) {
      await billingService.recordUsageLog({
        conversationId: conversation.id,
        requestId,
        modelId: runtimeModel.modelId,
        status: 'failed',
        errorMessage: '积分不足',
        inputLength: message.length,
        ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
        metadata: {
          estimatedCredits,
          balance,
          routingReason,
        },
      });

      return new Response(
        JSON.stringify({ error: '积分不足' }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const preDeduct = await billingService.preDeduct(estimatedCredits, {
      reason: 'AI 对话预扣',
      requestId,
    });

    await supabase
      .from('conversations')
      .update({ model_id: modelConfig.id })
      .eq('id', conversation.id)
      .eq('user_id', userId);

    const webSearchRequested = runtimeSettings.enableSmartSearchDecision && needsRealtimeData(message);
    const webSearchAvailable = webSearchRequested && runtimeModel.enableWebSearch;
    const apiKey = runtimeModel.apiKey || process.env.ANTHROPIC_API_KEY || null;

    if (!apiKey) {
      await billingService.refund(preDeduct.preDeductId, '未配置 API Key');
      await billingService.recordUsageLog({
        conversationId: conversation.id,
        requestId,
        modelId: runtimeModel.modelId,
        status: 'failed',
        errorMessage: '未配置 API Key',
        inputLength: message.length,
        latencyMs: 0,
      });

      return new Response(
        JSON.stringify({ error: '未配置 API Key，请在模型管理中配置或设置 ANTHROPIC_API_KEY 环境变量' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();
        let fullContent = '';
        let cachePoints = 0;
        let usage: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };

        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              type: 'init',
              conversationId: conversation.id,
              modelUsed: runtimeModel.modelId,
              requestId,
              routingReason,
              promptId: activePrompt?.id ?? null,
            })}\n\n`)
          );

          const openAICompatible = usesOpenAICompatibleApi({
            endpoint: runtimeModel.apiEndpoint,
            apiKey,
          });

          if (openAICompatible) {
            const endpoint = normalizeOpenAICompatibleEndpoint(runtimeModel.apiEndpoint) ||
              'https://openrouter.ai/api/v1/chat/completions';
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: getOpenAICompatibleHeaders(apiKey),
              body: JSON.stringify({
                model: runtimeModel.modelId,
                max_tokens: runtimeModel.maxTokens,
                stream: true,
                stream_options: { include_usage: true },
                messages: buildOpenAICompatibleMessages({
                  systemPrompt,
                  messages: providerMessages,
                }),
              }),
            });

            if (!response.ok) {
              const providerError = await getProviderErrorMessage(response);
              throw new Error(`OpenAI-compatible API error: ${response.status} - ${providerError}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error('No response body');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (!data || data === '[DONE]') continue;

                try {
                  const event = JSON.parse(data);
                  const delta = event.choices?.[0]?.delta?.content || '';
                  if (delta) {
                    fullContent += delta;
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`)
                    );
                  }

                  if (event.usage) {
                    usage.inputTokens = event.usage.prompt_tokens || usage.inputTokens;
                    usage.outputTokens = event.usage.completion_tokens || usage.outputTokens;
                  }
                } catch {
                  // Ignore non-JSON keepalive lines from upstream providers.
                }
              }
            }
          } else {
            const anthropicPayload = buildAnthropicPayload({
              modelId: runtimeModel.modelId,
              maxTokens: runtimeModel.maxTokens,
              messages: providerMessages,
              systemPrompt,
              enablePromptCache: runtimeSettings.enablePromptCache,
            });
            cachePoints = anthropicPayload.cachePoints;

            const response = await fetch(runtimeModel.apiEndpoint || 'https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify(anthropicPayload.payload),
            });

            if (!response.ok) {
              const providerError = await getProviderErrorMessage(response);
              throw new Error(`Anthropic API error: ${response.status} - ${providerError}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error('No response body');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (!data || data === '[DONE]') continue;

                try {
                  const event = JSON.parse(data);

                  if (event.type === 'content_block_delta') {
                    const delta = event.delta?.text || '';
                    fullContent += delta;
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`)
                    );
                  } else if (event.type === 'message_delta') {
                    if (event.usage) {
                      usage.outputTokens = event.usage.output_tokens || usage.outputTokens;
                    }
                  } else if (event.type === 'message_start') {
                    if (event.message?.usage) {
                      usage.inputTokens = event.message.usage.input_tokens || usage.inputTokens;
                      usage.cacheReadTokens = event.message.usage.cache_read_input_tokens || usage.cacheReadTokens;
                      usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens || usage.cacheCreationTokens;
                    }
                  }
                } catch {
                  // Ignore malformed provider frames.
                }
              }
            }
          }

          if (!usage.inputTokens) {
            usage.inputTokens = estimatedInputTokens;
          }
          if (!usage.outputTokens) {
            usage.outputTokens = estimateTokens(fullContent);
          }

          checkOutputSecurity(fullContent);

          const messageIds = await saveMessages(
            supabase,
            conversation.id,
            message,
            fullContent
          );

          if (conversation.isNew) {
            const title = message.length > 50 ? `${message.substring(0, 47)}...` : message;
            await supabase
              .from('conversations')
              .update({ title, model_id: modelConfig.id })
              .eq('id', conversation.id);
          }

          const actualCredits = Math.ceil(
            (usage.inputTokens * runtimeModel.inputTokenCost +
              usage.outputTokens * runtimeModel.outputTokenCost -
              usage.cacheReadTokens * runtimeModel.inputTokenCost * 0.9) /
            1000000
          );
          const totalCostUsd = (
            (usage.inputTokens * runtimeModel.inputTokenCost +
              usage.outputTokens * runtimeModel.outputTokenCost) /
            1000000000
          );
          const refundAmount = Math.max(0, preDeduct.estimatedCredits - actualCredits);

          await billingService.settle(
            preDeduct.preDeductId,
            actualCredits,
            usage,
            messageIds.assistantMessageId
              ? {
                messageId: messageIds.assistantMessageId,
                conversationId: conversation.id,
                content: fullContent,
              }
              : undefined
          );

          await billingService.recordTokenStats({
            conversationId: conversation.id,
            messageId: messageIds.assistantMessageId ?? undefined,
            modelUsed: runtimeModel.modelId,
            usage,
            costUsd: totalCostUsd,
            credits: actualCredits,
          });

          await billingService.recordUsageLog({
            conversationId: conversation.id,
            requestId,
            modelId: runtimeModel.modelId,
            status: 'success',
            inputLength: message.length,
            latencyMs: Date.now() - startedAt,
            ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
            userAgent: request.headers.get('user-agent') ?? undefined,
            metadata: {
              routingReason,
              promptId: activePrompt?.id ?? null,
              promptName: activePrompt?.name ?? null,
              promptCacheEnabled: runtimeSettings.enablePromptCache,
              promptCacheApplied: cachePoints > 0,
              cachePoints,
              webSearchRequested,
              webSearchAvailable,
              webSearchExecuted: false,
              selectedModelRecordId: modelConfig.id,
              selectedModelProvider: runtimeModel.provider,
            },
          });

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              type: 'complete',
              usage,
              cost: {
                creditsDeducted: actualCredits,
                estimatedCredits: preDeduct.estimatedCredits,
                refunded: refundAmount,
              },
              conversationId: conversation.id,
            })}\n\n`)
          );
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Unknown error';
          await billingService.refund(
            preDeduct.preDeductId,
            `AI 调用失败: ${messageText}`
          );
          await billingService.recordUsageLog({
            conversationId: conversation.id,
            requestId,
            modelId: runtimeModel.modelId,
            status: 'failed',
            errorMessage: messageText,
            inputLength: message.length,
            latencyMs: Date.now() - startedAt,
            ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
            userAgent: request.headers.get('user-agent') ?? undefined,
            metadata: {
              routingReason,
              promptId: activePrompt?.id ?? null,
              promptCacheEnabled: runtimeSettings.enablePromptCache,
              webSearchRequested,
              webSearchAvailable,
              webSearchExecuted: false,
            },
          });

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', error: messageText })}\n\n`)
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
