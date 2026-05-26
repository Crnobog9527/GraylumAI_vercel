/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ChatRuntimeSettings {
  siteName?: string;
  enableSmartRouting: boolean;
  enableSmartSearchDecision: boolean;
  enablePromptCache: boolean;
  enableFreeTier: boolean;
  freeTierMessages: number;
  maxMessagesPerConversation: number;
  maxInputCharacters: number;
  enableLongTextWarning: boolean;
  longTextWarningThreshold: number;
  showTokenUsageStats: boolean;
  smartRoutingMinConfidence: number;
  searchDecisionMinConfidence: number;
  searchSurchargeCredits: number;
  primaryModelId?: string;
  assistantModelId?: string;
  defaultModelId?: string;
  sonnetModelId?: string;
  haikuModelId?: string;
}

export interface ActiveChatPrompt {
  id: string;
  name: string;
  content: string;
  systemPrompt: string | null;
  userPromptTemplate: string | null;
  modelId: string | null;
  platform: 'all' | 'web' | 'mobile' | 'desktop' | 'api';
  category: string;
}

export type ModulePromptResolutionCode =
  | 'MODULE_NOT_FOUND'
  | 'MODULE_INACTIVE'
  | 'MODULE_PLATFORM_UNSUPPORTED'
  | 'MODULE_PROMPT_MISSING';

export class ModulePromptResolutionError extends Error {
  code: ModulePromptResolutionCode;
  statusCode: number;

  constructor(code: ModulePromptResolutionCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'ModulePromptResolutionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isModulePromptResolutionError(error: unknown): error is ModulePromptResolutionError {
  return error instanceof ModulePromptResolutionError;
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePromptPlatform(value: unknown, fallback: ActiveChatPrompt['platform']): ActiveChatPrompt['platform'] {
  if (value === 'all' || value === 'web' || value === 'mobile' || value === 'desktop' || value === 'api') {
    return value;
  }

  return fallback;
}

export async function resolveActiveModulePrompt(
  supabase: SupabaseClient,
  options: {
    moduleId: string;
    platform?: ActiveChatPrompt['platform'];
  },
): Promise<ActiveChatPrompt> {
  const platform = options.platform ?? 'web';
  const moduleId = options.moduleId.trim();
  const { data, error } = await supabase
    .from('modules')
    .select('id, title, description, prompt_content, system_prompt, user_prompt_template, model_id, platform, category, active')
    .eq('id', moduleId)
    .single();

  if (error || !data) {
    throw new ModulePromptResolutionError(
      'MODULE_NOT_FOUND',
      '功能模块不存在，请返回功能广场重新选择',
      404,
    );
  }

  if (data.active !== true) {
    throw new ModulePromptResolutionError(
      'MODULE_INACTIVE',
      '功能模块已下架，请返回功能广场重新选择',
      404,
    );
  }

  const modulePlatform = normalizePromptPlatform(data.platform, 'all');
  if (modulePlatform !== 'all' && modulePlatform !== platform) {
    throw new ModulePromptResolutionError(
      'MODULE_PLATFORM_UNSUPPORTED',
      '功能模块暂不支持当前入口',
      400,
    );
  }

  const title = normalizeOptionalText(data.title) ?? '未命名功能模块';
  const description = normalizeOptionalText(data.description);
  const promptContent = normalizeOptionalText(data.prompt_content);
  const systemPrompt = normalizeOptionalText(data.system_prompt);
  const userPromptTemplate = normalizeOptionalText(data.user_prompt_template);
  const fallbackPrompt = description
    ? `你正在作为「${title}」功能模块处理用户请求。\n模块说明：${description}`
    : null;
  const resolvedContent = promptContent ?? fallbackPrompt;

  if (!resolvedContent && !systemPrompt && !userPromptTemplate) {
    throw new ModulePromptResolutionError(
      'MODULE_PROMPT_MISSING',
      '功能模块提示词未配置，请联系管理员完善模块配置',
      400,
    );
  }

  return {
    id: data.id,
    name: title,
    content: resolvedContent ?? '',
    systemPrompt,
    userPromptTemplate,
    modelId: data.model_id ?? null,
    platform: modulePlatform,
    category: normalizeOptionalText(data.category) ?? 'other',
  };
}

function parseBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function parseStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseNumberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export async function getChatRuntimeSettings(
  supabase: SupabaseClient
): Promise<ChatRuntimeSettings> {
  const { data } = await supabase
    .from('system_settings')
    .select('key, value')
    .in('key', [
      'enable_smart_routing',
      'enable_smart_search_decision',
      'enable_prompt_cache',
      'enable_free_tier',
      'free_tier_messages',
      'max_messages_per_conversation',
      'max_input_characters',
      'enable_long_text_warning',
      'long_text_warning_threshold',
      'show_token_usage_stats',
      'smart_routing_min_confidence',
      'search_decision_min_confidence',
      'search_surcharge_credits',
      'primary_model_id',
      'assistant_model_id',
      'site_name',
      'ai_models',
    ]);

  const rawSettings = new Map<string, unknown>();
  for (const item of data ?? []) {
    rawSettings.set(item.key, item.value);
  }

  const aiModelsConfig = (rawSettings.get('ai_models') as Record<string, unknown> | null) ?? {};

  return {
    siteName: parseStringValue(rawSettings.get('site_name')),
    enableSmartRouting: parseBooleanValue(
      rawSettings.get('enable_smart_routing'),
      parseBooleanValue(aiModelsConfig.enableSmartRouting, true)
    ),
    enableSmartSearchDecision: parseBooleanValue(
      rawSettings.get('enable_smart_search_decision'),
      parseBooleanValue(aiModelsConfig.enableSmartSearchDecision, true)
    ),
    enablePromptCache: parseBooleanValue(
      rawSettings.get('enable_prompt_cache'),
      parseBooleanValue(aiModelsConfig.enablePromptCache, true)
    ),
    enableFreeTier: parseBooleanValue(rawSettings.get('enable_free_tier'), false),
    freeTierMessages: parseNumberValue(rawSettings.get('free_tier_messages'), 5),
    maxMessagesPerConversation: parseNumberValue(rawSettings.get('max_messages_per_conversation'), 100),
    maxInputCharacters: parseNumberValue(rawSettings.get('max_input_characters'), 2500),
    enableLongTextWarning: parseBooleanValue(rawSettings.get('enable_long_text_warning'), true),
    longTextWarningThreshold: parseNumberValue(rawSettings.get('long_text_warning_threshold'), 5000),
    showTokenUsageStats: parseBooleanValue(rawSettings.get('show_token_usage_stats'), true),
    smartRoutingMinConfidence: parseNumberValue(rawSettings.get('smart_routing_min_confidence'), 0.72),
    searchDecisionMinConfidence: parseNumberValue(rawSettings.get('search_decision_min_confidence'), 0.75),
    searchSurchargeCredits: parseNumberValue(rawSettings.get('search_surcharge_credits'), 0),
    primaryModelId: parseStringValue(rawSettings.get('primary_model_id')) ?? parseStringValue(aiModelsConfig.primaryModelId),
    assistantModelId: parseStringValue(rawSettings.get('assistant_model_id')) ?? parseStringValue(aiModelsConfig.assistantModelId),
    defaultModelId: parseStringValue(aiModelsConfig.defaultModelId),
    sonnetModelId: parseStringValue(aiModelsConfig.sonnetModelId),
    haikuModelId: parseStringValue(aiModelsConfig.haikuModelId),
  };
}

export function buildRuntimeSystemPrompt(prompt: ActiveChatPrompt | null): string | undefined {
  if (!prompt) return undefined;
  const parts = [prompt.systemPrompt, prompt.content]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function applyUserPromptTemplate(prompt: ActiveChatPrompt | null, input: string): string {
  const template = prompt?.userPromptTemplate?.trim();
  if (!template) return input;

  if (template.includes('{{input}}')) {
    return template.replaceAll('{{input}}', input);
  }

  if (template.includes('{input}')) {
    return template.replaceAll('{input}', input);
  }

  return `${template}\n\n${input}`;
}
