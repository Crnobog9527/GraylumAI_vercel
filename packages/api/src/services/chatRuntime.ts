/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ChatRuntimeSettings {
  enableSmartRouting: boolean;
  enableSmartSearchDecision: boolean;
  enablePromptCache: boolean;
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
      'ai_models',
    ]);

  const rawSettings = new Map<string, unknown>();
  for (const item of data ?? []) {
    rawSettings.set(item.key, item.value);
  }

  const aiModelsConfig = (rawSettings.get('ai_models') as Record<string, unknown> | null) ?? {};

  return {
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
