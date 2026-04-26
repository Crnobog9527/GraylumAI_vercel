/**
 * Model Router Service
 *
 * Experience-first model routing for primary/assistant model split.
 * The selected runtime model is recorded per request and must not lock the
 * conversation to a single family after the first turn.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getChatRuntimeSettings, type ChatRuntimeSettings } from './chatRuntime';

export interface ModelConfig {
  id: string;
  name: string;
  modelId: string;
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';
  maxTokens: number;
  inputLimit: number;
  enableWebSearch: boolean;
  inputTokenCost: number;
  outputTokenCost: number;
  apiKey?: string | null;
  apiEndpoint?: string | null;
  isActive: boolean;
  tokenCountingSupported?: boolean;
  tokenCountingMethod?: string;
  tokenizerFamily?: string | null;
  config?: Record<string, unknown>;
}

export type TaskType =
  | 'greeting'
  | 'chitchat'
  | 'lightweight_transform'
  | 'compression'
  | 'search_synthesis'
  | 'simple_qa'
  | 'coding'
  | 'reasoning'
  | 'creative_writing';

export interface RoutingContext {
  supabase: SupabaseClient;
  conversationId?: string;
  message: string;
  conversationTurns: number;
  userPreferredModel?: string;
  runtimeSettings?: ChatRuntimeSettings;
  defaultModels?: SystemDefaultModels;
}

export interface RoutingDecision {
  taskType: TaskType;
  confidence: number;
  modelRole: 'primary' | 'assistant' | 'user_selected';
  assistantEligible: boolean;
  reasonCodes: string[];
}

export interface RoutingResult {
  modelConfig: ModelConfig;
  routingReason: string;
  routingDecision: RoutingDecision;
}

export interface SearchDecision {
  shouldSearch: boolean;
  confidence: number;
  estimatedSearchCount: number;
  reasonCodes: string[];
}

export interface AssistantUpgradeDecision {
  shouldUpgrade: boolean;
  reasonCodes: string[];
}

export interface SystemDefaultModels {
  primary: ModelConfig;
  assistant: ModelConfig;
}

const DEFAULT_MODELS = {
  primary: {
    id: 'default-sonnet',
    name: 'Claude Sonnet via OpenRouter',
    modelId: 'anthropic/claude-sonnet-4.6',
    provider: 'openai' as const,
    maxTokens: 8192,
    inputLimit: 200000,
    enableWebSearch: false,
    inputTokenCost: 3000,
    outputTokenCost: 15000,
    apiKey: null,
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    isActive: true,
    tokenCountingSupported: true,
    tokenCountingMethod: 'provider_usage',
    tokenizerFamily: 'openai',
  },
  assistant: {
    id: 'default-haiku',
    name: 'Claude Haiku via OpenRouter',
    modelId: 'anthropic/claude-haiku-4.5',
    provider: 'openai' as const,
    maxTokens: 8192,
    inputLimit: 200000,
    enableWebSearch: false,
    inputTokenCost: 800,
    outputTokenCost: 4000,
    apiKey: null,
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    isActive: true,
    tokenCountingSupported: true,
    tokenCountingMethod: 'provider_usage',
    tokenizerFamily: 'openai',
  },
};

const GREETING_PATTERNS = [
  /^(你好|您好|嗨|哈喽|hello|hi|hey)\s*[!.?。！]*$/i,
  /^(早上好|下午好|晚上好|good (morning|afternoon|evening))$/i,
];

const CHITCHAT_PATTERNS = [
  /谢谢|thank(s| you)/i,
  /你是谁|who are you/i,
  /最近怎么样|how are you/i,
];

const LIGHTWEIGHT_TRANSFORM_PATTERNS = [
  /翻译|translate/i,
  /改写|润色|polish|rewrite/i,
  /总结一下|summari[sz]e|概括/i,
  /提炼|压缩|compress/i,
];

const CODING_PATTERNS = [
  /代码|程序|脚本|函数|bug|报错|调试|debug|stack trace|typescript|javascript|python|sql|api|正则/i,
  /实现|修复|优化.*代码/i,
];

const CREATIVE_PATTERNS = [
  /写(一篇|一个)?(文章|故事|文案|邮件|脚本|诗|标题)|创作|润色文案/i,
  /write (a|an)? (story|article|essay|copy|email|poem|script)/i,
];

const REASONING_PATTERNS = [
  /分析|推理|论证|规划|设计|方案|架构|比较|权衡|复盘/i,
  /why|analy[sz]e|reason|trade-?off|architecture|plan|strategy/i,
];

const SEARCH_PATTERNS = [
  /最新|今天|今日|当前|现在|recent|latest|today|now|current/i,
  /新闻|价格|股价|天气|汇率|比赛|赛程|政策|法规|行情/i,
  /查一下|搜一下|搜索|search|look up|find/i,
];

const PRE_FLIGHT_UPGRADE_PATTERNS = [
  /```/,
  /traceback|stack trace|exception|error:|报错|报异常/i,
  /sql\b|typescript\b|javascript\b|python\b|api\b|regex\b|正则/i,
];

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, value));
}

function inferTaskType(message: string, conversationTurns: number): {
  taskType: TaskType;
  confidence: number;
  reasonCodes: string[];
} {
  const normalized = message.trim();
  const reasonCodes: string[] = [];

  if (GREETING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('greeting_pattern');
    return { taskType: 'greeting', confidence: 0.98, reasonCodes };
  }

  if (CHITCHAT_PATTERNS.some((pattern) => pattern.test(normalized)) && normalized.length < 80) {
    reasonCodes.push('chitchat_pattern');
    return { taskType: 'chitchat', confidence: 0.84, reasonCodes };
  }

  if (LIGHTWEIGHT_TRANSFORM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('light_transform_pattern');
    const taskType: TaskType = /压缩|compress/i.test(normalized) ? 'compression' : 'lightweight_transform';
    return { taskType, confidence: normalized.length < 2000 ? 0.87 : 0.78, reasonCodes };
  }

  if (SEARCH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('search_synthesis_pattern');
    return { taskType: 'search_synthesis', confidence: 0.83, reasonCodes };
  }

  if (CODING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('coding_pattern');
    return { taskType: 'coding', confidence: 0.93, reasonCodes };
  }

  if (CREATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('creative_pattern');
    return { taskType: 'creative_writing', confidence: 0.88, reasonCodes };
  }

  if (REASONING_PATTERNS.some((pattern) => pattern.test(normalized)) || conversationTurns >= 3) {
    if (conversationTurns >= 3) reasonCodes.push('multi_turn_complexity');
    if (REASONING_PATTERNS.some((pattern) => pattern.test(normalized))) reasonCodes.push('reasoning_pattern');
    return { taskType: 'reasoning', confidence: conversationTurns >= 3 ? 0.86 : 0.8, reasonCodes };
  }

  if (normalized.length < 180) {
    reasonCodes.push('short_simple_query');
    return { taskType: 'simple_qa', confidence: 0.72, reasonCodes };
  }

  reasonCodes.push('default_reasoning_fallback');
  return { taskType: 'reasoning', confidence: 0.68, reasonCodes };
}

export function classifyTask(message: string, conversationTurns: number): TaskType {
  return inferTaskType(message, conversationTurns).taskType;
}

export function classifyTaskComplexity(message: string, conversationTurns: number): 'simple' | 'complex' {
  const taskType = classifyTask(message, conversationTurns);
  return ['greeting', 'chitchat', 'lightweight_transform', 'compression', 'search_synthesis', 'simple_qa'].includes(taskType)
    ? 'simple'
    : 'complex';
}

export function decideWebSearch(message: string): SearchDecision {
  const reasonCodes: string[] = [];
  const normalized = message.trim();

  if (GREETING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { shouldSearch: false, confidence: 0.99, estimatedSearchCount: 0, reasonCodes: ['greeting_no_search'] };
  }

  if (LIGHTWEIGHT_TRANSFORM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { shouldSearch: false, confidence: 0.9, estimatedSearchCount: 0, reasonCodes: ['transform_no_search'] };
  }

  if (SEARCH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    reasonCodes.push('explicit_realtime_signal');
  }

  const shouldSearch = reasonCodes.length > 0;
  return {
    shouldSearch,
    confidence: shouldSearch ? 0.88 : 0.7,
    estimatedSearchCount: shouldSearch ? 1 : 0,
    reasonCodes: shouldSearch ? reasonCodes : ['no_realtime_signals'],
  };
}

export function needsRealtimeData(message: string): boolean {
  return decideWebSearch(message).shouldSearch;
}

export function shouldUpgradeAssistantRoute(params: {
  message: string;
  decision: RoutingDecision;
  minConfidence: number;
}): AssistantUpgradeDecision {
  const { message, decision, minConfidence } = params;
  const reasonCodes: string[] = [];

  if (decision.modelRole !== 'assistant') {
    return { shouldUpgrade: false, reasonCodes };
  }

  if (decision.confidence < Math.max(minConfidence + 0.08, 0.9)) {
    reasonCodes.push('assistant_low_confidence');
  }

  if (message.length > 1600) {
    reasonCodes.push('assistant_long_input');
  }

  if (PRE_FLIGHT_UPGRADE_PATTERNS.some((pattern) => pattern.test(message))) {
    reasonCodes.push('assistant_code_or_error_context');
  }

  if (decision.taskType === 'search_synthesis' && message.length > 500) {
    reasonCodes.push('assistant_search_synthesis_escalated');
  }

  return {
    shouldUpgrade: reasonCodes.length > 0,
    reasonCodes,
  };
}

async function getModelConfigFromDb(supabase: SupabaseClient, modelId?: string): Promise<ModelConfig | null> {
  if (!modelId) return null;

  const { data } = await supabase
    .from('ai_models')
    .select('*')
    .eq('id', modelId)
    .eq('is_active', 'true')
    .single();

  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    modelId: data.model_id,
    provider: data.provider,
    maxTokens: data.max_tokens,
    inputLimit: data.input_limit,
    enableWebSearch: data.enable_web_search === 'true',
    inputTokenCost: data.input_token_cost,
    outputTokenCost: data.output_token_cost,
    apiKey: data.api_key ?? null,
    apiEndpoint: data.api_endpoint ?? null,
    isActive: data.is_active === 'true',
    tokenCountingSupported: data.token_counting_supported === 'true',
    tokenCountingMethod: data.token_counting_method,
    tokenizerFamily: data.tokenizer_family,
    config: data.config,
  };
}

async function getActiveModelConfigs(supabase: SupabaseClient): Promise<ModelConfig[]> {
  const { data, error } = await supabase
    .from('ai_models')
    .select('*')
    .eq('is_active', 'true')
    .order('name');

  if (error || !data) return [];

  return data.map((model) => ({
    id: model.id,
    name: model.name,
    modelId: model.model_id,
    provider: model.provider,
    maxTokens: model.max_tokens,
    inputLimit: model.input_limit,
    enableWebSearch: model.enable_web_search === 'true',
    inputTokenCost: model.input_token_cost,
    outputTokenCost: model.output_token_cost,
    apiKey: model.api_key ?? null,
    apiEndpoint: model.api_endpoint ?? null,
    isActive: model.is_active === 'true',
    tokenCountingSupported: model.token_counting_supported === 'true',
    tokenCountingMethod: model.token_counting_method,
    tokenizerFamily: model.tokenizer_family,
    config: model.config,
  }));
}

function scoreModelFamilyCandidate(model: ModelConfig, family: 'primary' | 'assistant'): number {
  const haystack = `${model.name} ${model.modelId} ${model.tokenizerFamily ?? ''}`.toLowerCase();
  let score = 0;

  if (family === 'primary') {
    if (haystack.includes('sonnet') || haystack.includes('opus') || haystack.includes('pro')) score += 12;
    score += Math.round(model.outputTokenCost / 1000);
  } else {
    if (haystack.includes('haiku') || haystack.includes('flash') || haystack.includes('mini')) score += 12;
    score += Math.max(0, 10 - Math.round(model.outputTokenCost / 1000));
  }

  if (model.tokenCountingSupported) score += 2;
  return score;
}

function pickBestModelFamilyCandidate(models: ModelConfig[], family: 'primary' | 'assistant'): ModelConfig | undefined {
  if (models.length === 0) return undefined;
  return [...models].sort((a, b) => {
    const diff = scoreModelFamilyCandidate(b, family) - scoreModelFamilyCandidate(a, family);
    if (diff !== 0) return diff;
    return b.outputTokenCost - a.outputTokenCost;
  })[0];
}

export async function getSystemDefaultModels(
  supabase: SupabaseClient,
  options: {
    runtimeSettings?: ChatRuntimeSettings;
    activeModels?: ModelConfig[];
  } = {},
): Promise<SystemDefaultModels> {
  const runtimeSettings = options.runtimeSettings ?? await getChatRuntimeSettings(supabase);
  const primaryModelId =
    runtimeSettings.primaryModelId ?? runtimeSettings.sonnetModelId ?? runtimeSettings.defaultModelId;
  const assistantModelId = runtimeSettings.assistantModelId ?? runtimeSettings.haikuModelId;

  const [activeModels, explicitPrimary, explicitAssistant] = await Promise.all([
    options.activeModels ? Promise.resolve(options.activeModels) : getActiveModelConfigs(supabase),
    getModelConfigFromDb(supabase, primaryModelId),
    getModelConfigFromDb(supabase, assistantModelId),
  ]);

  return {
    primary: explicitPrimary ?? pickBestModelFamilyCandidate(activeModels, 'primary') ?? DEFAULT_MODELS.primary,
    assistant: explicitAssistant ?? pickBestModelFamilyCandidate(activeModels, 'assistant') ?? explicitPrimary ?? DEFAULT_MODELS.assistant,
  };
}

export async function getSystemDefaultModelForRole(
  supabase: SupabaseClient,
  role: 'primary' | 'assistant',
): Promise<ModelConfig> {
  const defaults = await getSystemDefaultModels(supabase);
  return defaults[role];
}

export async function selectModel(ctx: RoutingContext): Promise<RoutingResult> {
  const { supabase, message, conversationTurns, userPreferredModel } = ctx;
  const runtimeSettings = ctx.runtimeSettings ?? await getChatRuntimeSettings(supabase);

  if (userPreferredModel) {
    const preferredModel = await getModelConfigFromDb(supabase, userPreferredModel);
    if (preferredModel) {
      return {
        modelConfig: preferredModel,
        routingReason: '使用用户显式指定模型',
        routingDecision: {
          taskType: inferTaskType(message, conversationTurns).taskType,
          confidence: 1,
          modelRole: 'user_selected',
          assistantEligible: false,
          reasonCodes: ['user_selected_model'],
        },
      };
    }
  }

  const defaults = ctx.defaultModels ?? await getSystemDefaultModels(supabase, { runtimeSettings });
  const inferred = inferTaskType(message, conversationTurns);
  const assistantEligible = runtimeSettings.enableSmartRouting &&
    ['greeting', 'chitchat', 'lightweight_transform', 'compression', 'search_synthesis', 'simple_qa'].includes(inferred.taskType) &&
    inferred.confidence >= runtimeSettings.smartRoutingMinConfidence;

  const modelConfig = assistantEligible ? defaults.assistant : defaults.primary;
  const modelRole: RoutingDecision['modelRole'] = assistantEligible ? 'assistant' : 'primary';
  const reasonCodes = [...inferred.reasonCodes, assistantEligible ? 'assistant_selected' : 'primary_selected'];

  return {
    modelConfig,
    routingReason: [
      `task=${inferred.taskType}`,
      `confidence=${clampConfidence(inferred.confidence).toFixed(2)}`,
      `role=${modelRole}`,
      ...reasonCodes,
    ].join('; '),
    routingDecision: {
      taskType: inferred.taskType,
      confidence: clampConfidence(inferred.confidence),
      modelRole,
      assistantEligible,
      reasonCodes,
    },
  };
}

export async function getAvailableModels(supabase: SupabaseClient): Promise<ModelConfig[]> {
  const models = await getActiveModelConfigs(supabase);
  return models.length > 0 ? models : [DEFAULT_MODELS.primary, DEFAULT_MODELS.assistant];
}

export async function validateModel(supabase: SupabaseClient, modelId: string): Promise<boolean> {
  const config = await getModelConfigFromDb(supabase, modelId);
  return config !== null && config.isActive;
}

export default {
  selectModel,
  classifyTask,
  classifyTaskComplexity,
  decideWebSearch,
  shouldUpgradeAssistantRoute,
  needsRealtimeData,
  getAvailableModels,
  validateModel,
  DEFAULT_MODELS,
};
