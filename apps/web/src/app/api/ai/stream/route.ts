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
import { BillingService, calculateTokenCostWithPricing, getModelPricing } from '@repo/api/src/services/billing';
import { buildCachedPrompt } from '@repo/api/src/services/promptCacheBuilder';
import { ContextManager } from '@repo/api/src/services/contextManager';
import { upsertContextSnapshot } from '@repo/api/src/services/contextSnapshots';
import {
  decideWebSearch,
  getSystemDefaultModelForRole,
  selectModel,
  shouldUpgradeAssistantRoute,
  type TaskType,
} from '@repo/api/src/services/modelRouter';
import {
  applyUserPromptTemplate,
  buildRuntimeSystemPrompt,
  getChatRuntimeSettings,
  resolveActiveChatPrompt,
} from '@repo/api/src/services/chatRuntime';
import { countTokens, estimateOutputTokens } from '@repo/api/src/services/tokenCounter';
import {
  getConfiguredProviderApiKey,
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
  tokenCountingSupported: boolean;
  tokenCountingMethod: string;
  tokenizerFamily: string | null;
}

type TokenCounterProvider = 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';

async function getUserAccountStatus(supabase: any, userId: string): Promise<'active' | 'disabled' | 'banned'> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('status')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw new Error('用户资料不存在');
  }

  if (profile.status === 'disabled') return 'disabled';
  if (profile.status === 'banned') return 'banned';
  return 'active';
}

async function getFreeTierUsageCount(supabase: any, userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('ai_usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'success')
    .gte('created_at', startOfDay.toISOString());

  if (error) {
    console.error('Failed to load free-tier usage count:', error);
    return 0;
  }

  return count ?? 0;
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
      .select('id, model_id, name, provider, max_tokens, input_token_cost, output_token_cost, api_key, api_endpoint, enable_web_search, token_counting_supported, token_counting_method, tokenizer_family')
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
        tokenCountingSupported: data.token_counting_supported === 'true',
        tokenCountingMethod: data.token_counting_method || 'unsupported',
        tokenizerFamily: data.tokenizer_family || null,
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
    tokenCountingSupported: true,
    tokenCountingMethod: 'anthropic_count_tokens',
    tokenizerFamily: 'anthropic',
  };
}

function buildAnthropicPayload(params: {
  modelId: string;
  maxTokens: number;
  messages: ClaudeMessage[];
  systemPrompt?: string;
  enablePromptCache: boolean;
  enableWebSearch?: boolean;
  maxWebSearchUses?: number;
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
      ...(params.enableWebSearch
        ? {
            tools: [
              {
                type: 'web_search_20250305',
                name: 'web_search',
                max_uses: params.maxWebSearchUses ?? 1,
              },
            ],
          }
        : {}),
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

function getGoogleApiKey(explicitKey?: string | null) {
  return explicitKey?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    null;
}

function mapTaskTypeToOutputEstimate(taskType: TaskType): Parameters<typeof estimateOutputTokens>[1] {
  switch (taskType) {
    case 'coding':
      return 'coding';
    case 'compression':
    case 'search_synthesis':
      return 'summary';
    case 'lightweight_transform':
      return 'translation';
    default:
      return 'chat';
  }
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

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
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
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const billingService = new BillingService({
      supabase: supabaseAdmin,
      userId,
    });

    const userStatus = await getUserAccountStatus(supabaseAuth, userId);
    if (userStatus === 'disabled') {
      return new Response(
        JSON.stringify({ error: '账号已被禁用，请联系管理员' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (userStatus === 'banned') {
      return new Response(
        JSON.stringify({ error: '账号已被封禁' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

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
      supabaseAuth,
      userId,
      conversationId,
      message.substring(0, 50)
    );
    const history = await getConversationHistory(supabaseAuth, conversation.id, MAX_CONTEXT_MESSAGES);
    const conversationTurns = Math.floor(history.length / 2);
    const runtimeSettings = await getChatRuntimeSettings(supabaseAdmin);

    if (message.length > runtimeSettings.maxInputCharacters) {
      return new Response(
        JSON.stringify({ error: `输入内容超过限制，当前最多允许 ${runtimeSettings.maxInputCharacters} 个字符` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (history.length >= runtimeSettings.maxMessagesPerConversation) {
      return new Response(
        JSON.stringify({ error: `当前对话已达到 ${runtimeSettings.maxMessagesPerConversation} 条消息上限，请新建对话后继续` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const initialSelection = await selectModel({
      supabase: supabaseAdmin,
      conversationId: conversation.id,
      message,
      conversationTurns,
      userPreferredModel: modelId,
    });
    let { modelConfig, routingReason, routingDecision } = initialSelection;

    const preFlightUpgrade = shouldUpgradeAssistantRoute({
      message,
      decision: routingDecision,
      minConfidence: runtimeSettings.smartRoutingMinConfidence,
    });

    if (preFlightUpgrade.shouldUpgrade) {
      let primaryModelId =
        runtimeSettings.primaryModelId ??
        runtimeSettings.sonnetModelId ??
        runtimeSettings.defaultModelId;

      if (!primaryModelId) {
        const primaryFallback = await getSystemDefaultModelForRole(supabaseAdmin, 'primary');
        primaryModelId = primaryFallback.id;
      }

      if (primaryModelId && primaryModelId !== modelConfig.id) {
        const upgradedSelection = await selectModel({
          supabase: supabaseAdmin,
          conversationId: conversation.id,
          message,
          conversationTurns,
          userPreferredModel: primaryModelId,
        });

        modelConfig = upgradedSelection.modelConfig;
        routingDecision = {
          ...routingDecision,
          modelRole: 'primary',
          assistantEligible: false,
          reasonCodes: [...routingDecision.reasonCodes, ...preFlightUpgrade.reasonCodes, 'route_upgraded_preflight'],
        };
        routingReason = `${routingReason}; route_upgraded_preflight; reasons=${preFlightUpgrade.reasonCodes.join(',')}`;
      }
    }

    const activePrompt = await resolveActiveChatPrompt(supabaseAdmin, {
      platform: 'web',
      modelId: modelConfig.id,
    });
    const systemPrompt = buildRuntimeSystemPrompt(activePrompt);
    const transformedMessage = applyUserPromptTemplate(activePrompt, message);

    const runtimeModel = await getRuntimeModelConfig(supabaseAdmin, {
      runtimeModelId: modelConfig.id,
      fallbackModelId: modelConfig.modelId,
      fallbackName: modelConfig.name,
      fallbackProvider: modelConfig.provider,
      fallbackMaxTokens: modelConfig.maxTokens,
      fallbackInputTokenCost: modelConfig.inputTokenCost,
      fallbackOutputTokenCost: modelConfig.outputTokenCost,
      fallbackEnableWebSearch: modelConfig.enableWebSearch,
    });

    if (!runtimeModel.tokenCountingSupported) {
      return new Response(
        JSON.stringify({ error: `模型 ${runtimeModel.name} 未配置可验证的 token 计数能力，禁止进入生产计费路径` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contextManager = new ContextManager(supabaseAuth);
    const loadedContext = await contextManager.loadContext(conversation.id);
    const builtContext = contextManager.buildMessages(
      loadedContext,
      transformedMessage,
      systemPrompt,
    );
    const providerMessages = builtContext.messages;
    const tokenCounterProvider: TokenCounterProvider =
      runtimeModel.tokenCountingMethod === 'anthropic_count_tokens'
        ? 'anthropic'
        : runtimeModel.tokenCountingMethod === 'gemini_count_tokens'
          ? 'google'
          : runtimeModel.tokenCountingMethod === 'verified_openai_tokenizer'
            ? 'openai'
            : runtimeModel.provider === 'anthropic' ||
                runtimeModel.provider === 'openai' ||
                runtimeModel.provider === 'google' ||
                runtimeModel.provider === 'builtin'
              ? runtimeModel.provider
              : 'custom';

    const countedInput = await countTokens({
      model: runtimeModel.modelId,
      provider: tokenCounterProvider,
      apiKey: runtimeModel.provider === 'google'
        ? getGoogleApiKey(runtimeModel.apiKey)
        : getConfiguredProviderApiKey(runtimeModel.apiKey),
      apiEndpoint: runtimeModel.apiEndpoint,
      tokenizerFamily: runtimeModel.tokenizerFamily,
      messages: providerMessages.map((entry: ClaudeMessage) => ({
        role: entry.role,
        content: entry.content,
      })),
      system: systemPrompt,
    }, {
      useOfficial: runtimeModel.tokenCountingMethod !== 'provider_usage',
      fallbackToEstimate: true,
    });

    const searchDecision = runtimeSettings.enableSmartSearchDecision
      ? decideWebSearch(message)
      : {
          shouldSearch: false,
          confidence: 1,
          estimatedSearchCount: 0,
          reasonCodes: ['smart_search_disabled'],
        };

    const estimatedUsage: TokenUsage = {
      inputTokens: countedInput.inputTokens,
      outputTokens: estimateOutputTokens(
        countedInput.inputTokens,
        mapTaskTypeToOutputEstimate(routingDecision.taskType),
      ),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const pricing = await getModelPricing(supabaseAdmin, runtimeModel.modelId);
    const estimatedCost = calculateTokenCostWithPricing(estimatedUsage, pricing, {
      searchCount: searchDecision.shouldSearch ? searchDecision.estimatedSearchCount : 0,
    });
    const estimatedCredits = estimatedCost.credits +
      ((searchDecision.shouldSearch ? searchDecision.estimatedSearchCount : 0) * runtimeSettings.searchSurchargeCredits);

    const balance = await billingService.getBalance();
    const freeTierUsedToday = runtimeSettings.enableFreeTier ? await getFreeTierUsageCount(supabaseAuth, userId) : 0;
    const canUseFreeTier = runtimeSettings.enableFreeTier
      && balance <= 0
      && freeTierUsedToday < runtimeSettings.freeTierMessages;
    if (balance < estimatedCredits && !canUseFreeTier) {
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
          freeTierEnabled: runtimeSettings.enableFreeTier,
          freeTierUsedToday,
          freeTierMessages: runtimeSettings.freeTierMessages,
          routingReason,
          promptId: activePrompt?.id ?? null,
          promptName: activePrompt?.name ?? null,
        },
      });

      return new Response(
        JSON.stringify({
          error: runtimeSettings.enableFreeTier && balance <= 0
            ? `免费体验次数已用完，当前每日上限为 ${runtimeSettings.freeTierMessages} 次`
            : '积分不足',
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const preDeduct = canUseFreeTier
      ? null
      : await billingService.preDeduct(estimatedCredits, {
        reason: 'AI 对话预扣',
        requestId,
      });

    const webSearchRequested = searchDecision.shouldSearch &&
      searchDecision.confidence >= runtimeSettings.searchDecisionMinConfidence;
    const webSearchAvailable = webSearchRequested &&
      runtimeModel.enableWebSearch &&
      ['anthropic', 'google'].includes(runtimeModel.provider);
    const apiKey = runtimeModel.provider === 'google'
      ? getGoogleApiKey(runtimeModel.apiKey)
      : getConfiguredProviderApiKey(runtimeModel.apiKey);

    if (!apiKey) {
      if (preDeduct) {
        await billingService.refund(preDeduct.preDeductId, '未配置 API Key');
      }
      await billingService.recordUsageLog({
        conversationId: conversation.id,
        requestId,
        modelId: runtimeModel.modelId,
        status: 'failed',
        errorMessage: '未配置 API Key',
        inputLength: message.length,
        latencyMs: 0,
        metadata: {
          freeTierUsed: canUseFreeTier,
          freeTierUsedToday,
          freeTierMessages: runtimeSettings.freeTierMessages,
          promptId: activePrompt?.id ?? null,
          promptName: activePrompt?.name ?? null,
        },
      });

      return new Response(
        JSON.stringify({ error: '未配置 API Key，请在模型管理中配置或设置 OPENROUTER_API_KEY / ANTHROPIC_API_KEY 环境变量' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();
        let fullContent = '';
        let cachePoints = 0;
        let actualSearchCount = 0;
        let webSearchExecuted = false;
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
              selectedModel: runtimeModel.name,
              taskType: routingDecision.taskType,
              routingConfidence: routingDecision.confidence,
              promptId: activePrompt?.id ?? null,
              promptName: activePrompt?.name ?? null,
            })}\n\n`)
          );

          const openAICompatible = usesOpenAICompatibleApi({
            endpoint: runtimeModel.apiEndpoint,
            apiKey,
          });

          if (webSearchAvailable) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'search_started',
                estimatedSearchCount: searchDecision.estimatedSearchCount,
                reasonCodes: searchDecision.reasonCodes,
              })}\n\n`)
            );
          }

          if (preFlightUpgrade.shouldUpgrade && routingDecision.modelRole === 'primary') {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'route_upgraded',
                modelUsed: runtimeModel.modelId,
                selectedModel: runtimeModel.name,
                reasonCodes: preFlightUpgrade.reasonCodes,
              })}\n\n`)
            );
          }

          if (openAICompatible) {
            const endpoint = normalizeOpenAICompatibleEndpoint(runtimeModel.apiEndpoint) ||
              'https://openrouter.ai/api/v1/chat/completions';
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: getOpenAICompatibleHeaders(apiKey, runtimeSettings.siteName),
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
          } else if (runtimeModel.provider === 'google') {
            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(runtimeModel.modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey ?? '')}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  contents: providerMessages.map((entry: ClaudeMessage) => ({
                    role: entry.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: typeof entry.content === 'string'
                      ? entry.content
                      : entry.content.map((block: { text?: string }) => block.text ?? '').join('\n') }],
                  })),
                  ...(systemPrompt
                    ? {
                        systemInstruction: {
                          role: 'system',
                          parts: [{ text: systemPrompt }],
                        },
                      }
                    : {}),
                  generationConfig: {
                    maxOutputTokens: runtimeModel.maxTokens,
                  },
                  ...(webSearchAvailable
                    ? {
                        tools: [{ google_search: {} }],
                      }
                    : {}),
                }),
              },
            );

            if (!response.ok) {
              const providerError = await getProviderErrorMessage(response);
              throw new Error(`Gemini API error: ${response.status} - ${providerError}`);
            }

            webSearchExecuted = webSearchAvailable;
            actualSearchCount = webSearchAvailable ? searchDecision.estimatedSearchCount : 0;

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
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                  const event = JSON.parse(data);
                  const parts = event.candidates?.[0]?.content?.parts ?? [];
                  const delta = parts
                    .map((part: { text?: string }) => part.text ?? '')
                    .join('');

                  if (delta) {
                    fullContent += delta;
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`)
                    );
                  }

                  if (event.usageMetadata) {
                    usage.inputTokens = event.usageMetadata.promptTokenCount || usage.inputTokens;
                    usage.outputTokens = event.usageMetadata.candidatesTokenCount || usage.outputTokens;
                  }
                } catch {
                  // Ignore malformed Gemini stream frames.
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
              enableWebSearch: webSearchAvailable,
              maxWebSearchUses: searchDecision.estimatedSearchCount,
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

            webSearchExecuted = webSearchAvailable;
            actualSearchCount = webSearchAvailable ? searchDecision.estimatedSearchCount : 0;

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
                  } else if (event.type === 'content_block_start') {
                    const blockType = event.content_block?.type;
                    if (blockType === 'server_tool_use' || blockType === 'web_search_tool_result') {
                      webSearchExecuted = true;
                      actualSearchCount = Math.max(actualSearchCount, 1);
                    }
                  }
                } catch {
                  // Ignore malformed provider frames.
                }
              }
            }
          }

          if (webSearchAvailable) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                type: 'search_finished',
                executed: webSearchExecuted,
                searchCount: actualSearchCount,
              })}\n\n`)
            );
          }

          if (!usage.inputTokens) {
            usage.inputTokens = countedInput.inputTokens;
          }
          if (!usage.outputTokens) {
            usage.outputTokens = estimateTokens(fullContent);
          }

          checkOutputSecurity(fullContent);

          if (conversation.isNew) {
            const title = message.length > 50 ? `${message.substring(0, 47)}...` : message;
            await supabaseAuth
              .from('conversations')
              .update({ title })
              .eq('id', conversation.id);
          }

          const calculatedCost = calculateTokenCostWithPricing(usage, pricing, {
            searchCount: actualSearchCount,
          });
          const actualCredits = canUseFreeTier
            ? 0
            : calculatedCost.credits + (actualSearchCount * runtimeSettings.searchSurchargeCredits);
          const finalizeResult = await billingService.finalizeAISuccess({
            conversationId: conversation.id,
            userMessage: message,
            assistantMessage: fullContent,
            modelUsed: runtimeModel.modelId,
            usage,
            costUsd: calculatedCost.costUsd,
            credits: actualCredits,
            preDeductId: preDeduct?.preDeductId ?? null,
            requestId,
            inputLength: message.length,
            latencyMs: Date.now() - startedAt,
            searchCount: actualSearchCount,
            ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
            userAgent: request.headers.get('user-agent') ?? undefined,
            tokenMetadata: {
              count_method: runtimeModel.tokenCountingMethod,
              count_source: countedInput.countSource,
              counter_version: countedInput.counterVersion,
              routing_decision: routingDecision,
            },
            usageMetadata: {
              routingReason,
              routingDecision,
              promptId: activePrompt?.id ?? null,
              promptName: activePrompt?.name ?? null,
              promptCacheEnabled: runtimeSettings.enablePromptCache,
              promptCacheApplied: cachePoints > 0,
              cachePoints,
              webSearchRequested,
              webSearchAvailable,
              webSearchExecuted,
              webSearchCount: actualSearchCount,
              selectedModelRecordId: modelConfig.id,
              selectedModelProvider: runtimeModel.provider,
              freeTierUsed: canUseFreeTier,
              freeTierUsedToday,
              freeTierMessages: runtimeSettings.freeTierMessages,
            },
          });

          if (builtContext.truncated || loadedContext.summary) {
            await upsertContextSnapshot(supabaseAuth, {
              conversationId: conversation.id,
              snapshotType: 'compression_checkpoint',
              content: loadedContext.summary ?? providerMessages.slice(0, Math.max(1, providerMessages.length - 1))
                .map((entry: ClaudeMessage) => `${entry.role}: ${typeof entry.content === 'string' ? entry.content : entry.content.map((block: { text?: string }) => block.text ?? '').join('\n')}`)
                .join('\n\n'),
              sourceMessageEndId: finalizeResult.assistantMessageId,
              sourceMessageCount: providerMessages.length,
              metadata: {
                totalTokens: loadedContext.totalTokens,
                truncated: builtContext.truncated,
                truncationReason: builtContext.truncationReason ?? null,
                hasSummary: loadedContext.summary ? true : false,
              },
            });
          }

          if (webSearchExecuted && fullContent) {
            await upsertContextSnapshot(supabaseAuth, {
              conversationId: conversation.id,
              snapshotType: 'search_digest',
              content: fullContent,
              sourceMessageEndId: finalizeResult.assistantMessageId,
              sourceMessageCount: 2,
              metadata: {
                searchCount: actualSearchCount,
                requestId,
                modelUsed: runtimeModel.modelId,
              },
            });
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              type: 'complete',
              usage,
              cost: {
                creditsDeducted: actualCredits,
                estimatedCredits: preDeduct?.estimatedCredits ?? 0,
                refunded: finalizeResult.refundedCredits,
              },
              conversationId: conversation.id,
              modelUsed: runtimeModel.modelId,
              searchCount: actualSearchCount,
              routingReason,
            })}\n\n`)
          );
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Unknown error';
          await billingService.finalizeAIFailure({
            conversationId: conversation.id,
            requestId,
            modelUsed: runtimeModel.modelId,
            reason: `AI 调用失败: ${messageText}`,
            preDeductId: preDeduct?.preDeductId ?? null,
            inputLength: message.length,
            latencyMs: Date.now() - startedAt,
            ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
            userAgent: request.headers.get('user-agent') ?? undefined,
            usageMetadata: {
              routingReason,
              routingDecision,
              promptId: activePrompt?.id ?? null,
              promptName: activePrompt?.name ?? null,
              promptCacheEnabled: runtimeSettings.enablePromptCache,
              webSearchRequested,
              webSearchAvailable,
              webSearchExecuted,
              webSearchCount: actualSearchCount,
              freeTierUsed: canUseFreeTier,
              freeTierUsedToday,
              freeTierMessages: runtimeSettings.freeTierMessages,
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
