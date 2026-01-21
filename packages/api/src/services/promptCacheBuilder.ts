/**
 * Prompt Cache Builder
 *
 * 构建带 cache_control 的提示词
 * 支持 Claude API 的 Prompt Caching 特性
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

import type { ClaudeMessage, ClaudeContentBlock } from '../types/ai';

// ============================================
// 常量
// ============================================

/**
 * 缓存断点阈值
 * 只有超过此 Token 数的内容才值得缓存
 */
const CACHE_THRESHOLDS = {
  // 最小缓存价值阈值 (Token 数)
  MIN_CACHE_TOKENS: 1024,
  // 推荐缓存阈值
  RECOMMENDED_CACHE_TOKENS: 2048,
  // 大型内容缓存阈值
  LARGE_CACHE_TOKENS: 4096,
};

/**
 * 缓存 TTL (秒)
 * Claude 缓存默认 5 分钟
 */
const CACHE_TTL = 300;

// ============================================
// 类型定义
// ============================================

export interface CacheableContent {
  type: 'system' | 'message' | 'tool';
  content: string | ClaudeContentBlock[];
  estimatedTokens: number;
  shouldCache: boolean;
  cacheReason?: string;
}

export interface CachedPromptResult {
  system?: string | ClaudeContentBlock[];
  messages: ClaudeMessage[];
  cachePoints: number; // 添加的缓存点数量
  estimatedCacheSavings: number; // 预估可节省的 Token 数
}

export interface PromptCacheConfig {
  /** 是否启用缓存 */
  enabled: boolean;
  /** 最小缓存 Token 阈值 */
  minCacheTokens?: number;
  /** 是否缓存系统提示词 */
  cacheSystemPrompt?: boolean;
  /** 是否缓存工具定义 */
  cacheTools?: boolean;
  /** 是否缓存历史消息 */
  cacheHistory?: boolean;
  /** 历史消息稳定区域大小 (轮次) */
  stableHistoryTurns?: number;
}

// ============================================
// 工具函数
// ============================================

/**
 * 估算文本 Token 数 (简化版)
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // 中文约 1.5 字符/Token，英文约 4 字符/Token，取平均 2.5
  return Math.ceil(text.length / 2.5);
}

/**
 * 估算内容块 Token 数
 */
function estimateContentBlockTokens(blocks: ClaudeContentBlock[]): number {
  return blocks.reduce((sum, block) => {
    if (block.type === 'text' && block.text) {
      return sum + estimateTokens(block.text);
    }
    // 图片/文档等按固定值估算
    return sum + 1000;
  }, 0);
}

/**
 * 添加 cache_control 到内容块
 */
function addCacheControl(block: ClaudeContentBlock): ClaudeContentBlock {
  return {
    ...block,
    cache_control: { type: 'ephemeral' },
  };
}

/**
 * 将字符串转换为带缓存控制的内容块数组
 */
function textToCachedBlocks(text: string): ClaudeContentBlock[] {
  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ============================================
// 主要构建器
// ============================================

/**
 * Prompt Cache Builder 类
 */
export class PromptCacheBuilder {
  private config: Required<PromptCacheConfig>;

  constructor(config: PromptCacheConfig = { enabled: true }) {
    this.config = {
      enabled: config.enabled,
      minCacheTokens: config.minCacheTokens ?? CACHE_THRESHOLDS.MIN_CACHE_TOKENS,
      cacheSystemPrompt: config.cacheSystemPrompt ?? true,
      cacheTools: config.cacheTools ?? true,
      cacheHistory: config.cacheHistory ?? true,
      stableHistoryTurns: config.stableHistoryTurns ?? 3,
    };
  }

  /**
   * 分析内容是否值得缓存
   */
  analyzeContent(content: string | ClaudeContentBlock[], type: CacheableContent['type']): CacheableContent {
    const estimatedTokens = typeof content === 'string'
      ? estimateTokens(content)
      : estimateContentBlockTokens(content);

    const shouldCache = this.config.enabled && estimatedTokens >= this.config.minCacheTokens;

    let cacheReason: string | undefined;
    if (shouldCache) {
      if (estimatedTokens >= CACHE_THRESHOLDS.LARGE_CACHE_TOKENS) {
        cacheReason = '大型内容，强烈建议缓存';
      } else if (estimatedTokens >= CACHE_THRESHOLDS.RECOMMENDED_CACHE_TOKENS) {
        cacheReason = '中型内容，建议缓存';
      } else {
        cacheReason = '内容超过最小阈值';
      }
    } else if (!this.config.enabled) {
      cacheReason = '缓存已禁用';
    } else {
      cacheReason = `内容过小 (${estimatedTokens} < ${this.config.minCacheTokens})`;
    }

    return {
      type,
      content,
      estimatedTokens,
      shouldCache,
      cacheReason,
    };
  }

  /**
   * 构建带缓存的系统提示词
   */
  buildSystemPrompt(systemPrompt?: string): string | ClaudeContentBlock[] | undefined {
    if (!systemPrompt) return undefined;

    const analysis = this.analyzeContent(systemPrompt, 'system');

    if (analysis.shouldCache && this.config.cacheSystemPrompt) {
      return textToCachedBlocks(systemPrompt);
    }

    return systemPrompt;
  }

  /**
   * 构建带缓存的消息列表
   *
   * 缓存策略:
   * 1. 稳定区域 (前 N 轮): 添加缓存点
   * 2. 动态区域 (最新消息): 不缓存
   */
  buildMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
    if (!this.config.enabled || !this.config.cacheHistory || messages.length === 0) {
      return messages;
    }

    // 计算稳定区域边界
    // 每轮对话包含 user + assistant 两条消息
    const stableMessageCount = this.config.stableHistoryTurns * 2;

    // 如果消息数少于稳定区域，不添加缓存
    if (messages.length <= stableMessageCount) {
      return messages;
    }

    const result: ClaudeMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      // 在稳定区域的最后一条消息添加缓存点
      if (i === stableMessageCount - 1) {
        result.push(this.addCacheToMessage(message));
      } else {
        result.push(message);
      }
    }

    return result;
  }

  /**
   * 给消息添加缓存控制
   */
  private addCacheToMessage(message: ClaudeMessage): ClaudeMessage {
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: textToCachedBlocks(message.content),
      };
    }

    // 如果已经是内容块数组，给最后一个块添加缓存控制
    const blocks = [...message.content];
    if (blocks.length > 0) {
      blocks[blocks.length - 1] = addCacheControl(blocks[blocks.length - 1]);
    }

    return {
      ...message,
      content: blocks,
    };
  }

  /**
   * 构建完整的带缓存提示词
   */
  build(params: {
    systemPrompt?: string;
    messages: ClaudeMessage[];
    tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  }): CachedPromptResult {
    let cachePoints = 0;
    let estimatedCacheSavings = 0;

    // 1. 处理系统提示词
    const system = this.buildSystemPrompt(params.systemPrompt);
    if (Array.isArray(system)) {
      cachePoints += 1;
      estimatedCacheSavings += estimateTokens(params.systemPrompt ?? '');
    }

    // 2. 处理消息
    const messages = this.buildMessages(params.messages);

    // 统计消息中的缓存点
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) {
            cachePoints += 1;
            if (block.type === 'text' && block.text) {
              estimatedCacheSavings += estimateTokens(block.text);
            }
          }
        }
      }
    }

    // 3. 工具定义的缓存在 API 请求时单独处理
    // Claude API 支持在 tools 数组最后一个元素添加 cache_control

    return {
      system,
      messages,
      cachePoints,
      estimatedCacheSavings,
    };
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(result: CachedPromptResult): {
    cachePoints: number;
    estimatedCacheSavings: number;
    estimatedCostSavings: number; // 美元
    cacheTTL: number;
  } {
    // 缓存读取成本约为原始成本的 10%
    // 所以节省约 90% 的输入成本
    const costPer1MTokens = 3.0; // Sonnet 价格
    const savingsRate = 0.9;
    const estimatedCostSavings =
      (result.estimatedCacheSavings / 1_000_000) * costPer1MTokens * savingsRate;

    return {
      cachePoints: result.cachePoints,
      estimatedCacheSavings: result.estimatedCacheSavings,
      estimatedCostSavings,
      cacheTTL: CACHE_TTL,
    };
  }
}

/**
 * 默认实例
 */
export const defaultCacheBuilder = new PromptCacheBuilder({ enabled: true });

/**
 * 快速构建带缓存的提示词
 */
export function buildCachedPrompt(params: {
  systemPrompt?: string;
  messages: ClaudeMessage[];
  config?: PromptCacheConfig;
}): CachedPromptResult {
  const builder = params.config
    ? new PromptCacheBuilder(params.config)
    : defaultCacheBuilder;

  return builder.build({
    systemPrompt: params.systemPrompt,
    messages: params.messages,
  });
}

export default PromptCacheBuilder;
