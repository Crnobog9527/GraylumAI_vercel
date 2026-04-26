/**
 * Token Counter Service
 *
 * Provider-aware token counting with official Gemini support and safe
 * fallbacks for providers that only expose authoritative post-response usage
 * metadata.
 */

import type { AIMessage } from '../types/ai';
import { logger } from '../lib/logger';
import {
  getFallbackProviderApiKey,
} from './providerUtils';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TOKEN_COUNTING_ERRORS = {
  anthropicRetired: 'Anthropic official token counting is retired; use OpenRouter usage metadata or estimates',
  geminiFailed: 'Gemini token counting failed',
  unsupportedProvider: 'Official token counting is not supported for this provider',
} as const;

const CHARS_PER_TOKEN = {
  chinese: 1.5,
  english: 4,
  mixed: 2.5,
};

export type CountSource =
  | 'anthropic_count_tokens'
  | 'gemini_count_tokens'
  | 'provider_usage'
  | 'estimate';

export interface TokenCountParams {
  model: string;
  provider?: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';
  apiKey?: string | null;
  apiEndpoint?: string | null;
  tokenizerFamily?: string | null;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; source?: unknown }>;
  }>;
  system?: string;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

export interface TokenCountResult {
  inputTokens: number;
  method: 'official' | 'estimate';
  countSource: CountSource;
  counterVersion: string;
  breakdown?: {
    messages: number;
    system: number;
    tools: number;
  };
}

function inferProvider(params: Pick<TokenCountParams, 'provider' | 'model' | 'apiEndpoint' | 'tokenizerFamily'>) {
  if (params.provider) return params.provider;
  const model = params.model.toLowerCase();
  const endpoint = params.apiEndpoint?.toLowerCase() ?? '';
  const family = params.tokenizerFamily?.toLowerCase() ?? '';

  if (model.startsWith('claude') || family === 'anthropic') return 'anthropic';
  if (model.startsWith('gemini') || family === 'gemini') return 'google';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || family === 'openai') return 'openai';
  if (endpoint.includes('openrouter') || endpoint.includes('chat/completions')) return 'custom';
  return 'custom';
}

function resolveProviderApiKey(params: Pick<TokenCountParams, 'provider' | 'apiKey'>) {
  if (params.apiKey?.trim()) return params.apiKey.trim();

  if (params.provider === 'google') {
    return process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || null;
  }

  return getFallbackProviderApiKey();
}

function normalizeMessageContent(content: TokenCountParams['messages'][number]['content']) {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
}

function toGeminiContents(messages: TokenCountParams['messages']) {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: normalizeMessageContent(message.content) }],
  }));
}

export async function countTokensOfficial(params: TokenCountParams): Promise<{ inputTokens: number; countSource: CountSource }> {
  const provider = inferProvider(params);
  const apiKey = resolveProviderApiKey({ provider, apiKey: params.apiKey });

  if (!apiKey) {
    throw new Error('No provider API key available for official token counting');
  }

  if (provider === 'anthropic') {
    throw new Error(TOKEN_COUNTING_ERRORS.anthropicRetired);
  }

  if (provider === 'google') {
    const response = await fetch(
      `${GEMINI_API_BASE}/${encodeURIComponent(params.model)}:countTokens?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: toGeminiContents(params.messages),
          ...(params.system
            ? {
                systemInstruction: {
                  role: 'system',
                  parts: [{ text: params.system }],
                },
              }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(TOKEN_COUNTING_ERRORS.geminiFailed);
    }

    const data = await response.json() as { totalTokens?: number };
    return {
      inputTokens: data.totalTokens ?? 0,
      countSource: 'gemini_count_tokens',
    };
  }

  throw new Error(TOKEN_COUNTING_ERRORS.unsupportedProvider);
}

function detectLanguage(text: string): 'chinese' | 'english' | 'mixed' {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const totalChars = text.length;
  if (totalChars === 0) return 'english';
  const chineseRatio = chineseChars / totalChars;
  if (chineseRatio > 0.5) return 'chinese';
  if (chineseRatio < 0.1) return 'english';
  return 'mixed';
}

export function estimateTokensFromString(text: string): number {
  if (!text) return 0;
  const language = detectLanguage(text);
  return Math.ceil(text.length / CHARS_PER_TOKEN[language]);
}

export function estimateTokensFromMessage(message: AIMessage): number {
  let tokens = 4;

  if (typeof message.content === 'string') {
    tokens += estimateTokensFromString(message.content);
    return tokens;
  }

  for (const block of message.content) {
    if (block.type === 'text' && 'text' in block) {
      tokens += estimateTokensFromString(block.text as string);
    } else if (block.type === 'image') {
      tokens += 1000;
    } else if (block.type === 'document') {
      tokens += 2000;
    }
  }

  return tokens;
}

export function estimateTokensFromMessages(messages: AIMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokensFromMessage(message), 5);
}

export function estimateSystemTokens(systemPrompt?: string): number {
  if (!systemPrompt) return 0;
  return estimateTokensFromString(systemPrompt) + 10;
}

export function estimateToolsTokens(tools?: TokenCountParams['tools']): number {
  if (!tools?.length) return 0;
  return tools.reduce((sum, tool) => {
    return sum +
      estimateTokensFromString(tool.name) +
      estimateTokensFromString(tool.description) +
      estimateTokensFromString(JSON.stringify(tool.input_schema)) +
      20;
  }, 0);
}

export async function countTokens(
  params: TokenCountParams,
  options: {
    useOfficial?: boolean;
    fallbackToEstimate?: boolean;
  } = {},
): Promise<TokenCountResult> {
  const { useOfficial = true, fallbackToEstimate = true } = options;

  if (useOfficial) {
    try {
      const result = await countTokensOfficial(params);
      return {
        inputTokens: result.inputTokens,
        method: 'official',
        countSource: result.countSource,
        counterVersion: '2026-03-10',
      };
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      logger.warn('ai', 'token_count_official_fallback_used', { errorName });
      if (!fallbackToEstimate) {
        throw error;
      }
    }
  }

  const messagesTokens = params.messages.reduce((sum, msg) => {
    return sum + estimateTokensFromString(normalizeMessageContent(msg.content)) + 4;
  }, 0);
  const systemTokens = estimateSystemTokens(params.system);
  const toolsTokens = estimateToolsTokens(params.tools);

  return {
    inputTokens: messagesTokens + systemTokens + toolsTokens,
    method: 'estimate',
    countSource: 'estimate',
    counterVersion: '2026-03-10',
    breakdown: {
      messages: messagesTokens,
      system: systemTokens,
      tools: toolsTokens,
    },
  };
}

export function quickEstimate(text: string): number {
  return estimateTokensFromString(text);
}

export function estimateOutputTokens(
  inputTokens: number,
  taskType: 'chat' | 'coding' | 'summary' | 'translation' = 'chat',
): number {
  const ratios: Record<string, number> = {
    chat: 0.5,
    coding: 1.5,
    summary: 0.3,
    translation: 1.0,
  };

  return Math.max(100, Math.min(4096, Math.ceil(inputTokens * (ratios[taskType] ?? 0.5))));
}

export default {
  countTokens,
  countTokensOfficial,
  quickEstimate,
  estimateTokensFromString,
  estimateTokensFromMessages,
  estimateOutputTokens,
};
