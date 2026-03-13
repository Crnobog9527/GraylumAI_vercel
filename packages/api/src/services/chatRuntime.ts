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

function scorePromptCandidate(
  prompt: ActiveChatPrompt,
  platform: ActiveChatPrompt['platform'],
  modelId?: string
) {
  let score = 0;
  if (prompt.platform === platform) score += 4;
  else if (prompt.platform === 'all') score += 2;

  if (modelId && prompt.modelId === modelId) score += 4;
  else if (!prompt.modelId) score += 1;

  return score;
}

export async function resolveActiveChatPrompt(
  supabase: SupabaseClient,
  options: {
    platform?: ActiveChatPrompt['platform'];
    modelId?: string;
  } = {}
): Promise<ActiveChatPrompt | null> {
  const platform = options.platform ?? 'web';
  const { data, error } = await supabase
    .from('prompts')
    .select('id, name, content, system_prompt, user_prompt_template, model_id, platform, category, active, is_system, is_deleted, sort_order, updated_at')
    .eq('active', 'true')
    .eq('is_system', 'true')
    .eq('is_deleted', 'false');

  if (error || !data || data.length === 0) {
    return null;
  }

  type PromptRow = {
    id: string;
    name: string;
    content: string;
    system_prompt: string | null;
    user_prompt_template: string | null;
    model_id: string | null;
    platform: ActiveChatPrompt['platform'];
    category: string;
    sort_order?: number | null;
    updated_at?: string | null;
  };

  const compatible = (data as PromptRow[])
    .filter((prompt) => prompt.platform === platform || prompt.platform === 'all')
    .filter((prompt) => !prompt.model_id || !options.modelId || prompt.model_id === options.modelId)
    .sort((a, b) => {
      const scoreDiff = scorePromptCandidate({
        id: b.id,
        name: b.name,
        content: b.content,
        systemPrompt: b.system_prompt,
        userPromptTemplate: b.user_prompt_template,
        modelId: b.model_id,
        platform: b.platform,
        category: b.category,
      }, platform, options.modelId) - scorePromptCandidate({
        id: a.id,
        name: a.name,
        content: a.content,
        systemPrompt: a.system_prompt,
        userPromptTemplate: a.user_prompt_template,
        modelId: a.model_id,
        platform: a.platform,
        category: a.category,
      }, platform, options.modelId);
      if (scoreDiff !== 0) return scoreDiff;
      if ((b.sort_order ?? 0) !== (a.sort_order ?? 0)) return (b.sort_order ?? 0) - (a.sort_order ?? 0);
      return new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime();
    });

  const selected = compatible[0];
  if (!selected) {
    return null;
  }

  return {
    id: selected.id,
    name: selected.name,
    content: selected.content,
    systemPrompt: selected.system_prompt,
    userPromptTemplate: selected.user_prompt_template,
    modelId: selected.model_id,
    platform: selected.platform,
    category: selected.category,
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
