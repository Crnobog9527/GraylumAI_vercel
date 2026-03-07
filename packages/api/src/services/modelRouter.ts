/**
 * Model Router Service
 *
 * AI 智能模型路由服务
 * 根据任务类型和对话上下文自动选择最佳模型
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getChatRuntimeSettings } from './chatRuntime';

// ============================================
// 类型定义
// ============================================

export interface ModelConfig {
  id: string;
  name: string;
  modelId: string; // Claude API 模型 ID
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';
  maxTokens: number;
  inputLimit: number;
  enableWebSearch: boolean;
  inputTokenCost: number;
  outputTokenCost: number;
  isActive: boolean;
  config?: Record<string, unknown>;
}

export interface RoutingContext {
  supabase: SupabaseClient;
  conversationId?: string;
  message: string;
  conversationTurns: number;
  userPreferredModel?: string;
}

export interface RoutingResult {
  modelConfig: ModelConfig;
  routingReason: string;
}

// ============================================
// 常量
// ============================================

/**
 * 简单任务关键词
 */
const SIMPLE_TASK_KEYWORDS = new Set([
  '你好', '嗨', 'hi', 'hello', 'hey',
  '谢谢', '感谢', 'thanks', 'thank you',
  '好的', 'ok', 'okay', '明白', '了解',
  '是', '否', '对', '不对', 'yes', 'no',
  '什么', '为什么', '怎么', '如何',
]);

/**
 * 复杂任务关键词
 */
const COMPLEX_TASK_KEYWORDS = [
  /写[一个]*[代码|程序|脚本|函数]/,
  /帮我[分析|设计|规划|实现]/,
  /详细[解释|说明|分析]/,
  /请[生成|创建|编写]/,
  /code|program|function|algorithm/i,
  /analyze|design|implement|explain/i,
  /debug|fix|solve|optimize/i,
];

/**
 * 实时数据关键词 (需要 Web Search)
 */
const REALTIME_DATA_KEYWORDS = [
  // 中文关键词
  /新闻|热点|热搜|热门/,
  /天气|气温|降水|下雨|下雪/,
  /股票|股价|涨跌|行情|大盘/,
  /实时|最新|今天|今日|当前|现在/,
  /比赛|赛事|比分|战绩|排名/,
  /价格|报价|汇率|油价|金价/,
  /疫情|病例|确诊/,
  /选举|投票|选情/,
  // 英文关键词
  /news|breaking|headline/i,
  /weather|temperature|forecast|rain|snow/i,
  /stock|price|market|trading|nasdaq|dow/i,
  /latest|current|today|now|real-?time/i,
  /score|match|game|sport|nba|nfl/i,
  /exchange rate|currency|bitcoin|crypto/i,
];

/**
 * 默认模型配置 (当数据库配置不可用时)
 */
const DEFAULT_MODELS = {
  sonnet: {
    id: 'default-sonnet',
    name: 'Claude Sonnet 4',
    modelId: 'claude-sonnet-4-20250514',
    provider: 'anthropic' as const,
    maxTokens: 8192,
    inputLimit: 200000,
    enableWebSearch: true,
    inputTokenCost: 3000, // $3 per 1M tokens in micro-dollars
    outputTokenCost: 15000,
    isActive: true,
  },
  haiku: {
    id: 'default-haiku',
    name: 'Claude Haiku 3.5',
    modelId: 'claude-3-5-haiku-20241022',
    provider: 'anthropic' as const,
    maxTokens: 8192,
    inputLimit: 200000,
    enableWebSearch: true,
    inputTokenCost: 800, // $0.80 per 1M tokens
    outputTokenCost: 4000,
    isActive: true,
  },
};

// ============================================
// 任务分类器
// ============================================

/**
 * 检测消息是否需要实时数据 (Web Search)
 */
export function needsRealtimeData(message: string): boolean {
  for (const pattern of REALTIME_DATA_KEYWORDS) {
    if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * 内联任务分类器
 * 不调用外部 API，使用规则引擎快速判断
 */
export function classifyTask(
  message: string,
  conversationTurns: number
): 'simple' | 'complex' {
  // 规则 1: 多轮对话倾向于使用更强的模型
  if (conversationTurns >= 3) {
    return 'complex';
  }

  // 规则 2: 短消息 + 简单关键词 = 简单任务
  const normalizedMessage = message.trim().toLowerCase();
  if (message.length < 20 && SIMPLE_TASK_KEYWORDS.has(normalizedMessage)) {
    return 'simple';
  }

  // 规则 3: 检测复杂任务关键词
  for (const pattern of COMPLEX_TASK_KEYWORDS) {
    if (pattern.test(message)) {
      return 'complex';
    }
  }

  // 规则 4: 长消息倾向于复杂任务
  if (message.length > 500) {
    return 'complex';
  }

  // 默认使用较强的模型
  return 'complex';
}

// ============================================
// 模型选择器
// ============================================

/**
 * 从数据库获取模型配置
 */
async function getModelConfigFromDb(
  supabase: SupabaseClient,
  modelId?: string
): Promise<ModelConfig | null> {
  if (modelId) {
    // 指定模型 ID
    const { data } = await supabase
      .from('ai_models')
      .select('*')
      .eq('id', modelId)
      .eq('is_active', 'true')
      .single();

    if (data) {
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
        isActive: data.is_active === 'true',
        config: data.config,
      };
    }
  }

  return null;
}

async function getActiveModelConfigs(
  supabase: SupabaseClient
): Promise<ModelConfig[]> {
  const { data, error } = await supabase
    .from('ai_models')
    .select('*')
    .eq('is_active', 'true')
    .order('name');

  if (error || !data) {
    return [];
  }

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
    isActive: model.is_active === 'true',
    config: model.config,
  }));
}

function scoreModelFamilyCandidate(
  model: ModelConfig,
  family: 'sonnet' | 'haiku'
): number {
  const haystack = `${model.name} ${model.modelId}`.toLowerCase();
  let score = 0;

  if (haystack.includes(family)) {
    score += 12;
  }

  if (family === 'sonnet') {
    if (model.enableWebSearch) score += 2;
    score += Math.round(model.outputTokenCost / 1000);
  } else {
    score += Math.max(0, 10 - Math.round(model.outputTokenCost / 1000));
  }

  return score;
}

function pickBestModelFamilyCandidate(
  models: ModelConfig[],
  family: 'sonnet' | 'haiku'
): ModelConfig | undefined {
  if (models.length === 0) return undefined;

  return [...models]
    .sort((a, b) => {
      const scoreDiff = scoreModelFamilyCandidate(b, family) - scoreModelFamilyCandidate(a, family);
      if (scoreDiff !== 0) return scoreDiff;
      return b.outputTokenCost - a.outputTokenCost;
    })[0];
}

/**
 * 获取系统默认模型配置
 */
async function getSystemDefaultModels(
  supabase: SupabaseClient
): Promise<{ sonnet?: ModelConfig; haiku?: ModelConfig }> {
  const runtimeSettings = await getChatRuntimeSettings(supabase);
  const activeModels = await getActiveModelConfigs(supabase);
  const result: { sonnet?: ModelConfig; haiku?: ModelConfig } = {};

  let defaultModel: ModelConfig | null = null;
  if (runtimeSettings.defaultModelId) {
    defaultModel = await getModelConfigFromDb(supabase, runtimeSettings.defaultModelId);
  }

  const activeDefaultModel = defaultModel ?? activeModels[0] ?? null;

  // 获取 Sonnet 模型
  if (runtimeSettings.sonnetModelId) {
    const sonnet = await getModelConfigFromDb(supabase, runtimeSettings.sonnetModelId);
    if (sonnet) result.sonnet = sonnet;
  }

  // 获取 Haiku 模型
  if (runtimeSettings.haikuModelId) {
    const haiku = await getModelConfigFromDb(supabase, runtimeSettings.haikuModelId);
    if (haiku) result.haiku = haiku;
  }

  // 如果后台未显式指定模型，则优先从当前启用模型中推断默认族群
  if (!result.sonnet) {
    result.sonnet = pickBestModelFamilyCandidate(activeModels, 'sonnet') ?? activeDefaultModel ?? DEFAULT_MODELS.sonnet;
  }

  if (!result.haiku) {
    result.haiku = pickBestModelFamilyCandidate(activeModels, 'haiku') ?? activeDefaultModel ?? result.sonnet ?? DEFAULT_MODELS.haiku;
  }

  return result;
}

/**
 * 获取对话锁定的模型
 */
async function getConversationModel(
  supabase: SupabaseClient,
  conversationId?: string
): Promise<ModelConfig | null> {
  if (!conversationId) return null;

  const { data: conversation } = await supabase
    .from('conversations')
    .select('model_id')
    .eq('id', conversationId)
    .single();

  if (conversation?.model_id) {
    return getModelConfigFromDb(supabase, conversation.model_id);
  }

  return null;
}

/**
 * 检查智能路由是否启用
 */
async function isSmartRoutingEnabled(supabase: SupabaseClient): Promise<boolean> {
  const runtimeSettings = await getChatRuntimeSettings(supabase);
  return runtimeSettings.enableSmartRouting;
}

// ============================================
// 主路由函数
// ============================================

/**
 * 选择最佳模型
 *
 * 优先级:
 * 1. 对话锁定模型 (conversation.model_id)
 * 2. 用户指定模型
 * 3. 智能路由 (根据任务类型选择)
 * 4. 系统默认模型
 */
export async function selectModel(ctx: RoutingContext): Promise<RoutingResult> {
  const { supabase, conversationId, message, conversationTurns, userPreferredModel } = ctx;

  // 1. 检查对话锁定模型
  const conversationModel = await getConversationModel(supabase, conversationId);
  if (conversationModel) {
    return {
      modelConfig: conversationModel,
      routingReason: '使用对话绑定模型',
    };
  }

  // 2. 用户指定模型
  if (userPreferredModel) {
    const preferredModel = await getModelConfigFromDb(supabase, userPreferredModel);
    if (preferredModel) {
      return {
        modelConfig: preferredModel,
        routingReason: '使用用户指定模型',
      };
    }
  }

  // 3. 获取系统模型配置
  const systemModels = await getSystemDefaultModels(supabase);

  // 4. 检查是否启用智能路由
  const smartRoutingEnabled = await isSmartRoutingEnabled(supabase);

  if (smartRoutingEnabled) {
    // 任务分类
    const taskType = classifyTask(message, conversationTurns);

    if (taskType === 'simple' && systemModels.haiku) {
      return {
        modelConfig: systemModels.haiku,
        routingReason: `智能路由: 简单任务使用 Haiku (消息长度: ${message.length}, 轮次: ${conversationTurns})`,
      };
    }
  }

  // 5. 默认使用 Sonnet
  return {
    modelConfig: systemModels.sonnet ?? DEFAULT_MODELS.sonnet,
    routingReason: smartRoutingEnabled
      ? `智能路由: 复杂任务使用 Sonnet`
      : '智能路由已禁用，使用默认模型',
  };
}

/**
 * 获取可用模型列表
 */
export async function getAvailableModels(
  supabase: SupabaseClient
): Promise<ModelConfig[]> {
  const models = await getActiveModelConfigs(supabase);

  if (models.length === 0) {
    // 返回默认模型
    return [DEFAULT_MODELS.sonnet, DEFAULT_MODELS.haiku];
  }

  return models;
}

/**
 * 验证模型是否可用
 */
export async function validateModel(
  supabase: SupabaseClient,
  modelId: string
): Promise<boolean> {
  const config = await getModelConfigFromDb(supabase, modelId);
  return config !== null && config.isActive;
}

export default {
  selectModel,
  classifyTask,
  getAvailableModels,
  validateModel,
  DEFAULT_MODELS,
};
