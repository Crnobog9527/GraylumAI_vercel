/**
 * Context Manager
 *
 * 管理对话上下文，实现滑动窗口策略
 * 支持历史摘要生成、稳定区域缓存、动态区域管理
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClaudeMessage } from '../types/ai';
import { estimateTokensFromString } from './tokenCounter';

// ============================================
// 常量
// ============================================

/**
 * 上下文配置
 */
const CONTEXT_CONFIG = {
  // 最大上下文 Token 数 (预留输出空间)
  MAX_CONTEXT_TOKENS: 150000,
  // 最大历史轮次
  MAX_HISTORY_TURNS: 50,
  // 摘要触发阈值 (Token 数) - 60% of MAX_CONTEXT_TOKENS
  SUMMARY_THRESHOLD: 90000, // 150000 * 0.6 = 90000
  // 稳定区域大小 (轮次) - 与 promptCacheBuilder 保持一致
  STABLE_REGION_TURNS: 3,
  // 动态区域大小 (轮次)
  DYNAMIC_REGION_TURNS: 10,
  // 摘要最大 Token 数
  SUMMARY_MAX_TOKENS: 2000,
};

// ============================================
// 类型定义
// ============================================

export interface ContextMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  tokenCount?: number;
}

export interface ConversationContext {
  conversationId: string;
  summary?: string;
  summaryTokens?: number;
  summaryUpdatedAt?: string;
  stableRegion: ContextMessage[];
  dynamicRegion: ContextMessage[];
  totalTokens: number;
}

export interface ContextManagerConfig {
  maxContextTokens?: number;
  maxHistoryTurns?: number;
  summaryThreshold?: number;
  stableRegionTurns?: number;
  dynamicRegionTurns?: number;
}

export interface ContextBuildResult {
  messages: ClaudeMessage[];
  totalTokens: number;
  includedTurns: number;
  hasSummary: boolean;
  truncated: boolean;
  truncationReason?: string;
}

// ============================================
// Context Manager 类
// ============================================

export class ContextManager {
  private supabase: SupabaseClient;
  private config: Required<ContextManagerConfig>;

  constructor(supabase: SupabaseClient, config: ContextManagerConfig = {}) {
    this.supabase = supabase;
    this.config = {
      maxContextTokens: config.maxContextTokens ?? CONTEXT_CONFIG.MAX_CONTEXT_TOKENS,
      maxHistoryTurns: config.maxHistoryTurns ?? CONTEXT_CONFIG.MAX_HISTORY_TURNS,
      summaryThreshold: config.summaryThreshold ?? CONTEXT_CONFIG.SUMMARY_THRESHOLD,
      stableRegionTurns: config.stableRegionTurns ?? CONTEXT_CONFIG.STABLE_REGION_TURNS,
      dynamicRegionTurns: config.dynamicRegionTurns ?? CONTEXT_CONFIG.DYNAMIC_REGION_TURNS,
    };
  }

  /**
   * 加载对话上下文
   */
  async loadContext(conversationId: string): Promise<ConversationContext> {
    // 1. 获取对话元数据 (包括摘要)
    const { data: conversation } = await this.supabase
      .from('conversations')
      .select('id, summary, summary_tokens, summary_updated_at')
      .eq('id', conversationId)
      .single();

    // 2. 获取消息历史
    const { data: messages } = await this.supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(this.config.maxHistoryTurns * 2);

    const contextMessages: ContextMessage[] = (messages ?? []).map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      createdAt: m.created_at,
      tokenCount: estimateTokensFromString(m.content),
    }));

    // 3. 划分区域
    const totalMessages = contextMessages.length;
    const stableCount = Math.min(
      this.config.stableRegionTurns * 2,
      totalMessages
    );
    const dynamicStart = Math.max(0, totalMessages - this.config.dynamicRegionTurns * 2);

    // 稳定区域: 最早的 N 条消息
    const stableRegion = contextMessages.slice(0, stableCount);

    // 动态区域: 最新的 M 条消息
    const dynamicRegion = contextMessages.slice(dynamicStart);

    // 计算总 Token 数
    const totalTokens = contextMessages.reduce(
      (sum, m) => sum + (m.tokenCount ?? 0),
      0
    ) + (conversation?.summary_tokens ?? 0);

    return {
      conversationId,
      summary: conversation?.summary,
      summaryTokens: conversation?.summary_tokens,
      summaryUpdatedAt: conversation?.summary_updated_at,
      stableRegion,
      dynamicRegion,
      totalTokens,
    };
  }

  /**
   * 构建用于 API 调用的消息列表
   */
  buildMessages(
    context: ConversationContext,
    newMessage: string,
    systemPrompt?: string
  ): ContextBuildResult {
    const result: ContextBuildResult = {
      messages: [],
      totalTokens: 0,
      includedTurns: 0,
      hasSummary: false,
      truncated: false,
    };

    // 预留系统提示词和新消息的 Token
    const systemTokens = systemPrompt ? estimateTokensFromString(systemPrompt) : 0;
    const newMessageTokens = estimateTokensFromString(newMessage);
    const reservedTokens = systemTokens + newMessageTokens + 4096; // 预留输出空间

    let availableTokens = this.config.maxContextTokens - reservedTokens;

    // 1. 如果有摘要且上下文过大，先添加摘要
    if (context.summary && context.totalTokens > this.config.summaryThreshold) {
      const summaryMessage: ClaudeMessage = {
        role: 'user',
        content: `[对话历史摘要]\n${context.summary}\n\n请基于以上摘要继续对话。`,
      };
      result.messages.push(summaryMessage);
      availableTokens -= (context.summaryTokens ?? estimateTokensFromString(context.summary));
      result.hasSummary = true;
    }

    // 2. 添加稳定区域消息
    for (const msg of context.stableRegion) {
      const tokens = msg.tokenCount ?? estimateTokensFromString(msg.content);
      if (availableTokens >= tokens) {
        result.messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
        availableTokens -= tokens;
        result.totalTokens += tokens;
      } else {
        result.truncated = true;
        result.truncationReason = '稳定区域部分截断';
        break;
      }
    }

    // 3. 添加动态区域消息 (优先保留最新的)
    const dynamicMessages = [...context.dynamicRegion];
    const includedDynamic: ClaudeMessage[] = [];

    // 从最新的开始，倒序添加
    for (let i = dynamicMessages.length - 1; i >= 0; i--) {
      const msg = dynamicMessages[i];
      const tokens = msg.tokenCount ?? estimateTokensFromString(msg.content);

      if (availableTokens >= tokens) {
        includedDynamic.unshift({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
        availableTokens -= tokens;
        result.totalTokens += tokens;
      } else {
        result.truncated = true;
        result.truncationReason = result.truncationReason ?? '动态区域部分截断';
        break;
      }
    }

    // 合并动态区域消息
    result.messages.push(...includedDynamic);

    // 4. 添加新消息
    result.messages.push({
      role: 'user',
      content: newMessage,
    });
    result.totalTokens += newMessageTokens;

    // 计算包含的轮次
    result.includedTurns = Math.floor(
      result.messages.filter((m) => m.role === 'user').length
    );

    return result;
  }

  /**
   * 检查是否需要生成摘要
   */
  shouldGenerateSummary(context: ConversationContext): boolean {
    // 1. Token 数超过阈值
    if (context.totalTokens > this.config.summaryThreshold) {
      return true;
    }

    // 2. 消息数超过阈值且没有摘要
    const totalMessages = context.stableRegion.length + context.dynamicRegion.length;
    if (totalMessages > this.config.maxHistoryTurns && !context.summary) {
      return true;
    }

    return false;
  }

  /**
   * 生成对话摘要提示词
   */
  generateSummaryPrompt(context: ConversationContext): string {
    const allMessages = [...context.stableRegion, ...context.dynamicRegion];

    const messageText = allMessages
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n\n');

    return `请对以下对话进行简洁的摘要，保留关键信息和上下文。摘要应该便于后续对话参考。

对话内容:
${messageText}

请生成摘要 (不超过 500 字):`;
  }

  /**
   * 保存摘要
   */
  async saveSummary(conversationId: string, summary: string): Promise<void> {
    const summaryTokens = estimateTokensFromString(summary);

    await this.supabase
      .from('conversations')
      .update({
        summary,
        summary_tokens: summaryTokens,
        summary_updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);
  }

  /**
   * 清理旧消息 (保留最近 N 条)
   */
  async cleanupOldMessages(
    conversationId: string,
    keepCount: number = 100
  ): Promise<number> {
    // 获取要保留的消息 ID
    const { data: keepMessages } = await this.supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(keepCount);

    if (!keepMessages || keepMessages.length < keepCount) {
      return 0;
    }

    const keepIds = keepMessages.map((m) => m.id);

    // 删除不在保留列表中的消息
    const { count } = await this.supabase
      .from('messages')
      .delete({ count: 'exact' })
      .eq('conversation_id', conversationId)
      .not('id', 'in', `(${keepIds.join(',')})`);

    return count ?? 0;
  }

  /**
   * 获取上下文统计
   */
  getContextStats(context: ConversationContext): {
    totalMessages: number;
    totalTokens: number;
    stableRegionSize: number;
    dynamicRegionSize: number;
    hasSummary: boolean;
    summaryAge?: number; // 摘要年龄 (毫秒)
    needsSummary: boolean;
  } {
    const now = Date.now();
    const summaryAge = context.summaryUpdatedAt
      ? now - new Date(context.summaryUpdatedAt).getTime()
      : undefined;

    return {
      totalMessages: context.stableRegion.length + context.dynamicRegion.length,
      totalTokens: context.totalTokens,
      stableRegionSize: context.stableRegion.length,
      dynamicRegionSize: context.dynamicRegion.length,
      hasSummary: !!context.summary,
      summaryAge,
      needsSummary: this.shouldGenerateSummary(context),
    };
  }
}

/**
 * 快速构建上下文
 */
export async function buildContext(
  supabase: SupabaseClient,
  conversationId: string,
  newMessage: string,
  options: {
    systemPrompt?: string;
    config?: ContextManagerConfig;
  } = {}
): Promise<ContextBuildResult> {
  const manager = new ContextManager(supabase, options.config);
  const context = await manager.loadContext(conversationId);
  return manager.buildMessages(context, newMessage, options.systemPrompt);
}

export default ContextManager;
