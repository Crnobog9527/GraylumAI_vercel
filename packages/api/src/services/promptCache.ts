/**
 * Prompt Cache Service
 *
 * 优化 Anthropic Prompt Caching 策略
 * 提高缓存命中率，降低成本
 */

// ============================================
// Types
// ============================================

export interface CacheableMessage {
  role: 'user' | 'assistant';
  content: string | CacheableContent[];
}

export interface CacheableContent {
  type: 'text';
  text: string;
  cache_control?: {
    type: 'ephemeral';
  };
}

export interface SystemPromptConfig {
  content: string;
  enableCache?: boolean;
}

export interface CacheStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  tokensSaved: number;
  costSaved: number;
}

// ============================================
// Constants
// ============================================

// Minimum tokens for caching to be effective (Anthropic minimum is 1024)
const MIN_CACHE_TOKENS = 1024;

// Cost reduction for cached tokens (90% cheaper)
const CACHE_COST_REDUCTION = 0.9;

// Default system prompt (cacheable)
const DEFAULT_SYSTEM_PROMPT = `You are Claude, a helpful AI assistant created by Anthropic.
You are knowledgeable, thoughtful, and aim to provide accurate, helpful responses.
You communicate clearly and concisely, adapting your tone to match the conversation.
When you're uncertain about something, you acknowledge it rather than guessing.
You respect user privacy and avoid making assumptions about personal information.`;

// ============================================
// Utility Functions
// ============================================

/**
 * Estimate token count for a string
 * Rough estimate: 4 chars per token for English, 1.5 for Chinese
 */
export function estimateTokenCount(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * Check if content is worth caching based on token count
 */
export function shouldCache(text: string): boolean {
  return estimateTokenCount(text) >= MIN_CACHE_TOKENS;
}

// ============================================
// Cache Optimization Functions
// ============================================

/**
 * Build optimized system prompt with cache control
 *
 * The system prompt is the best candidate for caching because:
 * 1. It remains constant across requests
 * 2. It's typically long (many tokens)
 * 3. It's at the beginning of the context (required for caching)
 */
export function buildCacheableSystemPrompt(
  customPrompt?: string
): CacheableContent[] {
  const prompt = customPrompt || DEFAULT_SYSTEM_PROMPT;

  // Only add cache control if the prompt is long enough
  const useCache = shouldCache(prompt);

  return [
    {
      type: 'text',
      text: prompt,
      ...(useCache && { cache_control: { type: 'ephemeral' } }),
    },
  ];
}

/**
 * Build optimized messages array with strategic cache points
 *
 * Caching strategy:
 * 1. Always cache the system prompt
 * 2. Cache conversation history prefix (older messages)
 * 3. Don't cache recent messages (they change frequently)
 */
export function buildCacheableMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: {
    cacheHistoryThreshold?: number; // Number of messages to consider for caching
    minHistoryTokens?: number; // Minimum tokens before caching history
  } = {}
): CacheableMessage[] {
  const { cacheHistoryThreshold = 4, minHistoryTokens = 2048 } = options;

  if (messages.length === 0) return [];

  // Calculate cumulative tokens
  let cumulativeTokens = 0;
  const messagesWithTokens = messages.map((m) => ({
    ...m,
    tokens: estimateTokenCount(m.content),
    cumulativeTokens: (cumulativeTokens += estimateTokenCount(m.content)),
  }));

  // Find the best cache breakpoint
  // We want to cache messages that are:
  // 1. At least cacheHistoryThreshold messages old
  // 2. Have at least minHistoryTokens cumulative tokens
  let cacheBreakpoint = -1;

  for (let i = 0; i < messagesWithTokens.length - 2; i++) {
    const msg = messagesWithTokens[i];
    const isOldEnough = i < messagesWithTokens.length - cacheHistoryThreshold;
    const hasEnoughTokens = msg.cumulativeTokens >= minHistoryTokens;

    if (isOldEnough && hasEnoughTokens) {
      cacheBreakpoint = i;
    }
  }

  // Build messages with cache control
  return messagesWithTokens.map((m, i) => {
    // Add cache control at the breakpoint
    if (i === cacheBreakpoint) {
      return {
        role: m.role,
        content: [
          {
            type: 'text' as const,
            text: m.content,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
      };
    }

    // Regular message
    return {
      role: m.role,
      content: m.content,
    };
  });
}

/**
 * Build complete cacheable request payload
 */
export function buildCacheOptimizedRequest(params: {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
}): {
  model: string;
  max_tokens: number;
  system: CacheableContent[];
  messages: CacheableMessage[];
} {
  return {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    system: buildCacheableSystemPrompt(params.systemPrompt),
    messages: buildCacheableMessages(params.messages),
  };
}

// ============================================
// Cache Monitoring
// ============================================

/**
 * Calculate cache efficiency metrics from usage data
 */
export function calculateCacheEfficiency(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): {
  hitRate: number;
  tokensSaved: number;
  costSavingsPercent: number;
} {
  const totalInputTokens =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  if (totalInputTokens === 0) {
    return { hitRate: 0, tokensSaved: 0, costSavingsPercent: 0 };
  }

  const hitRate = usage.cacheReadTokens / totalInputTokens;
  const tokensSaved = usage.cacheReadTokens;
  const costSavingsPercent = hitRate * CACHE_COST_REDUCTION * 100;

  return {
    hitRate: Math.round(hitRate * 100) / 100,
    tokensSaved,
    costSavingsPercent: Math.round(costSavingsPercent * 100) / 100,
  };
}

/**
 * Aggregate cache statistics from multiple requests
 */
export function aggregateCacheStats(
  usageRecords: Array<{
    input_tokens: number;
    cached_tokens: number;
    cache_creation_tokens?: number;
  }>
): CacheStats {
  const stats = usageRecords.reduce(
    (acc, record) => {
      const inputTokens = record.input_tokens ?? 0;
      const cachedTokens = record.cached_tokens ?? 0;
      const cacheCreation = record.cache_creation_tokens ?? 0;

      return {
        totalRequests: acc.totalRequests + 1,
        totalInputTokens: acc.totalInputTokens + inputTokens + cachedTokens,
        totalCachedTokens: acc.totalCachedTokens + cachedTokens,
        totalCacheCreation: acc.totalCacheCreation + cacheCreation,
      };
    },
    {
      totalRequests: 0,
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalCacheCreation: 0,
    }
  );

  const hitRate =
    stats.totalInputTokens > 0
      ? stats.totalCachedTokens / stats.totalInputTokens
      : 0;

  // Estimate cost savings (cached tokens are 90% cheaper)
  const costSaved = stats.totalCachedTokens * CACHE_COST_REDUCTION;

  return {
    totalRequests: stats.totalRequests,
    cacheHits: stats.totalCachedTokens > 0 ? stats.totalRequests : 0,
    cacheMisses: stats.totalCachedTokens === 0 ? stats.totalRequests : 0,
    hitRate: Math.round(hitRate * 100),
    tokensSaved: stats.totalCachedTokens,
    costSaved: Math.round(costSaved),
  };
}

// ============================================
// Export
// ============================================

export const promptCache = {
  buildCacheableSystemPrompt,
  buildCacheableMessages,
  buildCacheOptimizedRequest,
  calculateCacheEfficiency,
  aggregateCacheStats,
  estimateTokenCount,
  shouldCache,
  MIN_CACHE_TOKENS,
  CACHE_COST_REDUCTION,
};

export default promptCache;
