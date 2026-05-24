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
import { filterAIOutput, logger } from '@repo/api/src/services';
import {
  BillingService,
  ModelPricingUnavailableError,
  calculateTokenCostWithPricing,
  estimatePreDeductCredits,
  getBillingRuntimeSettings,
  getModelPricing,
} from '@repo/api/src/services/billing';
import { ContextManager } from '@repo/api/src/services/contextManager';
import { upsertContextSnapshot } from '@repo/api/src/services/contextSnapshots';
import {
  decideWebSearch,
  getSystemDefaultModels,
  selectModel,
  shouldUpgradeAssistantRoute,
  type TaskType,
} from '@repo/api/src/services/modelRouter';
import {
  applyUserPromptTemplate,
  buildRuntimeSystemPrompt,
  getChatRuntimeSettings,
  isModulePromptResolutionError,
  resolveActiveModulePrompt,
} from '@repo/api/src/services/chatRuntime';
import { countTokens, estimateOutputTokens } from '@repo/api/src/services/tokenCounter';
import {
  getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders,
  normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi,
} from '@repo/api/src/services/providerUtils';
import type { ClaudeMessage } from '@repo/api/src/types/ai';

interface StreamRequest {
  message: string;
  conversationId?: string;
  modelId?: string;
  moduleId?: string;
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

const STREAM_AUTH_FAILURE_MESSAGE = '身份验证失败，请重新登录';
const STREAM_RUNTIME_FAILURE_MESSAGE = 'AI 响应生成失败，请稍后重试';
const STREAM_SERVICE_UNAVAILABLE_MESSAGE = 'AI 对话服务暂时不可用，请稍后重试';
const STREAM_PRICING_UNAVAILABLE_MESSAGE = '模型计费价格未配置，请联系管理员';
const STREAM_PROVIDER_FAILURE_MESSAGE = '上游 AI 服务请求失败';
const STREAM_PROVIDER_EMPTY_BODY_MESSAGE = '上游 AI 服务未返回响应体';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logAiStreamError(message: string, metadata?: Record<string, unknown>) {
  logger.error('ai', message, metadata);
}

function normalizeRequestId(requestId?: string): string | undefined {
  const trimmed = requestId?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (UUID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  logAiStreamError('ai_stream_invalid_request_id_ignored', {
    requestIdLength: trimmed.length,
  });

  return undefined;
}

function normalizeModuleId(moduleId?: string): string | undefined {
  const trimmed = moduleId?.trim();
  if (!trimmed) {
    return undefined;
  }

  return UUID_PATTERN.test(trimmed) ? trimmed : '';
}

async function getUserSecurityProfile(
  supabase: any,
  userId: string
): Promise<{ status: 'active' | 'disabled' | 'banned'; role: 'user' | 'admin' }> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('status, role')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw new Error('用户资料不存在');
  }

  return {
    status: profile.status === 'disabled' || profile.status === 'banned' ? profile.status : 'active',
    role: profile.role === 'admin' ? 'admin' : 'user',
  };
}

async function isMaintenanceModeEnabled(supabase: any): Promise<boolean> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle();

  if (error) {
    logAiStreamError('ai_stream_maintenance_mode_read_failed');
    return true;
  }

  const value = data?.value;
  return value === true || value === 'true';
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
    logAiStreamError('ai_stream_free_tier_usage_count_failed');
    return 0;
  }

  return count ?? 0;
}

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function recordStageTiming(stageTimings: Record<string, number>, name: string, startedAt: number) {
  stageTimings[name] = Date.now() - startedAt;
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
    tokenCountingMethod: options.fallbackProvider === 'google' ? 'gemini_count_tokens' : 'provider_usage',
    tokenizerFamily: options.fallbackProvider === 'google' ? 'gemini' : 'openai',
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
    const requestStartedAt = Date.now();
    const stageTimings: Record<string, number> = {};
    const body: StreamRequest = await request.json();
    const { conversationId, modelId } = body;
    const moduleId = normalizeModuleId(body.moduleId);
    const message = body.message?.trim();
    const requestId = normalizeRequestId(body.requestId) ?? crypto.randomUUID();

    if (!message) {
      return new Response(
        JSON.stringify({ error: '消息内容不能为空' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (moduleId === '') {
      return new Response(
        JSON.stringify({ error: '功能模块参数无效，请返回功能广场重新选择' }),
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
    recordStageTiming(stageTimings, 'auth', requestStartedAt);

    if (authError || !user) {
      logAiStreamError('ai_stream_auth_failed', {
        hasAuthError: Boolean(authError),
        hasUser: Boolean(user),
      });
      return new Response(
        JSON.stringify({ error: STREAM_AUTH_FAILURE_MESSAGE }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.id;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const billingService = new BillingService({
      supabase: supabaseAdmin,
      userId,
    });

    const profileStartedAt = Date.now();
    const maintenanceStartedAt = Date.now();
    const runtimeSettingsStartedAt = Date.now();
    const billingSettingsStartedAt = Date.now();
    const [userSecurityProfile, maintenanceModeEnabled, runtimeSettings, billingRuntimeSettings] = await Promise.all([
      getUserSecurityProfile(supabaseAuth, userId),
      isMaintenanceModeEnabled(supabaseAdmin),
      getChatRuntimeSettings(supabaseAdmin),
      getBillingRuntimeSettings(supabaseAdmin),
    ]);
    recordStageTiming(stageTimings, 'profile', profileStartedAt);
    recordStageTiming(stageTimings, 'maintenance', maintenanceStartedAt);
    recordStageTiming(stageTimings, 'runtime_settings', runtimeSettingsStartedAt);
    recordStageTiming(stageTimings, 'billing_settings', billingSettingsStartedAt);

    if (userSecurityProfile.status === 'disabled') {
      return new Response(
        JSON.stringify({ error: '账号已被禁用，请联系管理员' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (userSecurityProfile.status === 'banned') {
      return new Response(
        JSON.stringify({ error: '账号已被封禁' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (maintenanceModeEnabled && userSecurityProfile.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: '系统维护中，暂时无法使用 AI 对话功能' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const rateLimitStartedAt = Date.now();
    const rateLimitResult = await checkRateLimit(userId, 'ai_stream');
    recordStageTiming(stageTimings, 'rate_limit', rateLimitStartedAt);
    if (!rateLimitResult.success) {
      const isRateLimitUnavailable = rateLimitResult.reason === 'unavailable';
      await billingService.recordUsageLog({
        requestId,
        status: isRateLimitUnavailable ? 'failed' : 'rate_limited',
        modelId: 'unknown',
        inputLength: message.length,
        ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
        errorMessage: isRateLimitUnavailable ? 'rate_limit_unavailable' : undefined,
      });

      return new Response(
        JSON.stringify({
          error: isRateLimitUnavailable ? '服务暂不可用' : '请求过于频繁',
          message: isRateLimitUnavailable
            ? '限流服务暂时不可用，请稍后重试'
            : `请在 ${rateLimitResult.retryAfter} 秒后重试`,
          retryAfter: rateLimitResult.retryAfter,
        }),
        {
          status: isRateLimitUnavailable ? 503 : 429,
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

    const modulePromptStartedAt = Date.now();
    let activePrompt: Awaited<ReturnType<typeof resolveActiveModulePrompt>> | null = null;
    if (moduleId) {
      try {
        activePrompt = await resolveActiveModulePrompt(supabaseAdmin, {
          moduleId,
          platform: 'web',
        });
      } catch (error) {
        if (isModulePromptResolutionError(error)) {
          return new Response(
            JSON.stringify({ error: error.message, code: error.code }),
            { status: error.statusCode, headers: { 'Content-Type': 'application/json' } }
          );
        }

        throw error;
      }
    }
    recordStageTiming(stageTimings, 'module_prompt_resolution', modulePromptStartedAt);

    const defaultModelsStartedAt = Date.now();
    const defaultModelsPromise = getSystemDefaultModels(supabaseAdmin, { runtimeSettings });
    const conversationStartedAt = Date.now();
    const conversation = await getOrCreateConversation(
      supabaseAuth,
      userId,
      conversationId,
      message.substring(0, 50)
    );
    recordStageTiming(stageTimings, 'conversation_lookup_or_create', conversationStartedAt);

    const historyStartedAt = Date.now();
    const [history, defaultModels] = await Promise.all([
      getConversationHistory(supabaseAuth, conversation.id, MAX_CONTEXT_MESSAGES),
      defaultModelsPromise,
    ]);
    recordStageTiming(stageTimings, 'conversation_history', historyStartedAt);
    recordStageTiming(stageTimings, 'routing_defaults', defaultModelsStartedAt);
    const conversationTurns = Math.floor(history.length / 2);

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

    const routingStartedAt = Date.now();
    const initialSelection = await selectModel({
      supabase: supabaseAdmin,
      conversationId: conversation.id,
      message,
      conversationTurns,
      userPreferredModel: activePrompt?.modelId ?? modelId,
      runtimeSettings,
      defaultModels,
    });
    let { modelConfig, routingReason, routingDecision } = initialSelection;
    recordStageTiming(stageTimings, 'model_routing', routingStartedAt);

    if (activePrompt?.modelId && modelConfig.id !== activePrompt.modelId) {
      return new Response(
        JSON.stringify({ error: '功能模块指定模型不可用，请联系管理员更新模块配置' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const preFlightUpgrade = shouldUpgradeAssistantRoute({
      message,
      decision: routingDecision,
      minConfidence: runtimeSettings.smartRoutingMinConfidence,
    });

    if (!activePrompt?.modelId && preFlightUpgrade.shouldUpgrade) {
      let primaryModelId =
        runtimeSettings.primaryModelId ??
        runtimeSettings.sonnetModelId ??
        runtimeSettings.defaultModelId ??
        defaultModels.primary.id;

      if (primaryModelId && primaryModelId !== modelConfig.id) {
        const rerouteStartedAt = Date.now();
        const upgradedSelection = await selectModel({
          supabase: supabaseAdmin,
          conversationId: conversation.id,
          message,
          conversationTurns,
          userPreferredModel: primaryModelId,
          runtimeSettings,
          defaultModels,
        });
        recordStageTiming(stageTimings, 'model_rerouting', rerouteStartedAt);

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

    const runtimeModelStartedAt = Date.now();
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
    recordStageTiming(stageTimings, 'runtime_model', runtimeModelStartedAt);
    const systemPrompt = buildRuntimeSystemPrompt(activePrompt);
    const transformedMessage = applyUserPromptTemplate(activePrompt, message);

    if (!runtimeModel.tokenCountingSupported) {
      return new Response(
        JSON.stringify({ error: STREAM_SERVICE_UNAVAILABLE_MESSAGE }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contextManager = new ContextManager(supabaseAuth);
    const contextStartedAt = Date.now();
    const loadedContext = await contextManager.loadContext(conversation.id);
    const builtContext = contextManager.buildMessages(
      loadedContext,
      transformedMessage,
      systemPrompt,
    );
    recordStageTiming(stageTimings, 'context_load', contextStartedAt);
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

    const pricingStartedAt = Date.now();
    const pricingPromise = getModelPricing(supabaseAdmin, runtimeModel.modelId, {
      requireModelPricing: billingRuntimeSettings.requireModelPricing,
    }).then(
      (pricing) => ({ pricing }),
      (error) => ({ error }),
    );
    const tokenCountStartedAt = Date.now();
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
    recordStageTiming(stageTimings, 'token_counting', tokenCountStartedAt);

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
    let pricing: Awaited<ReturnType<typeof getModelPricing>>;
    const pricingResult = await pricingPromise;
    if ('error' in pricingResult) {
      const { error } = pricingResult;
      if (error instanceof ModelPricingUnavailableError) {
        logger.warn('billing', 'ai_stream_model_pricing_unavailable', {
          modelId: runtimeModel.modelId,
          reason: error.reason,
        });
        await billingService.recordUsageLog({
          conversationId: conversation.id,
          requestId,
          modelId: runtimeModel.modelId,
          status: 'failed',
          errorMessage: 'model_pricing_unavailable',
          inputLength: message.length,
          ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
          userAgent: request.headers.get('user-agent') ?? undefined,
          metadata: {
            routingReason,
            routingDecision,
            selectedModelRecordId: modelConfig.id,
            pricingFailureReason: error.reason,
          },
        });

        return new Response(
          JSON.stringify({ error: STREAM_PRICING_UNAVAILABLE_MESSAGE }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw error;
    }
    pricing = pricingResult.pricing;
    recordStageTiming(stageTimings, 'pricing_lookup', pricingStartedAt);
    const estimatedCost = calculateTokenCostWithPricing(estimatedUsage, pricing, {
      searchCount: searchDecision.shouldSearch ? searchDecision.estimatedSearchCount : 0,
    }, billingRuntimeSettings);
    const estimatedCredits = estimatePreDeductCredits(
      estimatedCost.credits +
        ((searchDecision.shouldSearch ? searchDecision.estimatedSearchCount : 0) * runtimeSettings.searchSurchargeCredits),
      billingRuntimeSettings,
    );

    const balanceStartedAt = Date.now();
    const freeTierStartedAt = Date.now();
    const [balance, freeTierUsedToday] = await Promise.all([
      billingService.getBalance(),
      runtimeSettings.enableFreeTier ? getFreeTierUsageCount(supabaseAuth, userId) : Promise.resolve(0),
    ]);
    recordStageTiming(stageTimings, 'balance_lookup', balanceStartedAt);
    recordStageTiming(stageTimings, 'free_tier_lookup', freeTierStartedAt);
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

    stageTimings.preflight = Date.now() - requestStartedAt;

    const webSearchRequested = searchDecision.shouldSearch &&
      searchDecision.confidence >= runtimeSettings.searchDecisionMinConfidence;
    const webSearchAvailable = webSearchRequested &&
      runtimeModel.enableWebSearch &&
      runtimeModel.provider === 'google';
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
        JSON.stringify({ error: STREAM_SERVICE_UNAVAILABLE_MESSAGE }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();
        let firstProviderChunkAt: number | null = null;
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
              preflightLatencyMs: stageTimings.preflight,
              stageTimingsMs: stageTimings,
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

          const providerStartedAt = Date.now();
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
              logAiStreamError('ai_stream_openai_compatible_provider_failed', {
                provider: runtimeModel.provider,
                modelId: runtimeModel.modelId,
                status: response.status,
              });
              throw new Error(STREAM_PROVIDER_FAILURE_MESSAGE);
            }

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error(STREAM_PROVIDER_EMPTY_BODY_MESSAGE);
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (firstProviderChunkAt === null) {
                firstProviderChunkAt = Date.now();
              }

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
              logAiStreamError('ai_stream_gemini_provider_failed', {
                provider: runtimeModel.provider,
                modelId: runtimeModel.modelId,
                status: response.status,
              });
              throw new Error(STREAM_PROVIDER_FAILURE_MESSAGE);
            }

            webSearchExecuted = webSearchAvailable;
            actualSearchCount = webSearchAvailable ? searchDecision.estimatedSearchCount : 0;

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error(STREAM_PROVIDER_EMPTY_BODY_MESSAGE);
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (firstProviderChunkAt === null) {
                firstProviderChunkAt = Date.now();
              }

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
            logAiStreamError('ai_stream_provider_not_openrouter_compatible', {
              provider: runtimeModel.provider,
              modelId: runtimeModel.modelId,
              hasEndpoint: Boolean(runtimeModel.apiEndpoint),
            });
            throw new Error(STREAM_PROVIDER_FAILURE_MESSAGE);
          }
          stageTimings.provider_stream = Date.now() - providerStartedAt;
          stageTimings.provider_first_chunk = firstProviderChunkAt === null
            ? stageTimings.provider_stream
            : firstProviderChunkAt - providerStartedAt;

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

          const filteredOutput = filterAIOutput(fullContent);
          const assistantContent = filteredOutput.content;

          if (filteredOutput.blocked || filteredOutput.sanitized) {
            logger.security.contentBlocked(
              user.id,
              filteredOutput.reasons.join(',') || 'output_filtered',
              'output',
              { requestId, conversationId: conversation.id }
            );
          }

          if (conversation.isNew) {
            const title = message.length > 50 ? `${message.substring(0, 47)}...` : message;
            await supabaseAuth
              .from('conversations')
              .update({ title })
              .eq('id', conversation.id);
          }

          const calculatedCost = calculateTokenCostWithPricing(usage, pricing, {
            searchCount: actualSearchCount,
          }, billingRuntimeSettings);
          const actualCredits = canUseFreeTier
            ? 0
            : calculatedCost.credits + (actualSearchCount * runtimeSettings.searchSurchargeCredits);
          const pricingMetadata = {
            inputPer1M: pricing.inputPer1M,
            outputPer1M: pricing.outputPer1M,
            searchPer1K: pricing.searchPer1K ?? 0,
            pricingSource: 'ai_models',
            modelId: runtimeModel.modelId,
          };

          if (
            usage.inputTokens + usage.outputTokens > 0 &&
            pricing.inputPer1M > 0 &&
            pricing.outputPer1M > 0 &&
            calculatedCost.costUsd.toFixed(6) === '0.000000'
          ) {
            logger.warn('billing', 'ai_stream_cost_rounded_to_zero', {
              modelId: runtimeModel.modelId,
              usage,
              pricing: pricingMetadata,
              costUsd: calculatedCost.costUsd,
              credits: actualCredits,
            });
          }

          const finalizeResult = await billingService.finalizeAISuccess({
            conversationId: conversation.id,
            userMessage: message,
            assistantMessage: assistantContent,
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
              routingDecision,
              pricing: pricingMetadata,
              billingSettingsSnapshot: {
                creditsPerUsd: billingRuntimeSettings.creditsPerUsd,
                tokenPriceMultiplier: billingRuntimeSettings.tokenPriceMultiplier,
                minPreDeduct: billingRuntimeSettings.minPreDeduct,
                maxPreDeduct: billingRuntimeSettings.maxPreDeduct,
                safetyMargin: billingRuntimeSettings.safetyMargin,
              },
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
              performanceTimingsMs: stageTimings,
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

          if (webSearchExecuted && assistantContent) {
            await upsertContextSnapshot(supabaseAuth, {
              conversationId: conversation.id,
              snapshotType: 'search_digest',
              content: assistantContent,
              sourceMessageEndId: finalizeResult.assistantMessageId,
              sourceMessageCount: 2,
              metadata: {
                searchCount: actualSearchCount,
                requestId,
                modelUsed: runtimeModel.modelId,
              },
            });
          }

          if (assistantContent) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: assistantContent })}\n\n`)
            );
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
          logAiStreamError('ai_stream_provider_execution_failed', {
            modelId: runtimeModel.modelId,
            requestId,
          });
          await billingService.finalizeAIFailure({
            conversationId: conversation.id,
            requestId,
            modelUsed: runtimeModel.modelId,
            reason: 'AI 调用失败，请查看服务端日志',
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
              performanceTimingsMs: stageTimings,
            },
          });

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'error', error: STREAM_RUNTIME_FAILURE_MESSAGE })}\n\n`
            )
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
    logAiStreamError('ai_stream_request_bootstrap_failed');
    return new Response(
      JSON.stringify({ error: STREAM_SERVICE_UNAVAILABLE_MESSAGE }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
