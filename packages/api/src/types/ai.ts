/**
 * AI Request/Response Types
 *
 * 这些类型定义用于 AI 对话系统的请求和响应
 * 使用 Zod 进行运行时验证，同时导出 TypeScript 类型
 */

import { z } from 'zod';

// ============================================
// 消息相关类型
// ============================================

/**
 * 内容块类型 - 支持多模态消息
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.enum(['base64', 'url']),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string(),
    }),
  }),
  z.object({
    type: z.literal('document'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.literal('application/pdf'),
      data: z.string(),
    }),
  }),
]);

/**
 * AI 消息格式
 */
export const AIMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([
    z.string(),
    z.array(ContentBlockSchema),
  ]),
});

// ============================================
// 请求相关类型
// ============================================

/**
 * 附件类型
 */
export const AttachmentSchema = z.object({
  type: z.enum(['image', 'pdf']),
  base64Data: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
});

/**
 * AI 请求输入验证
 */
export const AIRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1, '消息不能为空').max(100000, '消息过长'),
  modelId: z.string().uuid().optional(),
  moduleId: z.string().uuid().optional(),
  enableWebSearch: z.boolean().optional().default(false),
  attachments: z.array(AttachmentSchema).optional(),
  // 幂等性 Key - 用于防止重复请求
  requestId: z.string().uuid().optional(),
  // 可选的上下文配置
  contextConfig: z.object({
    maxHistoryTurns: z.number().min(0).max(50).optional(),
    enableSummary: z.boolean().optional(),
    enableCaching: z.boolean().optional(),
  }).optional(),
});

/**
 * 流式请求配置
 */
export const StreamRequestSchema = AIRequestSchema.extend({
  stream: z.literal(true).default(true),
});

// ============================================
// 响应相关类型
// ============================================

/**
 * Token 使用统计
 */
export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional().default(0),
  cacheCreationTokens: z.number().optional().default(0),
  totalTokens: z.number().optional(),
});

/**
 * 成本明细
 */
export const CostBreakdownSchema = z.object({
  input: z.number(), // 输入 Token 成本 (积分)
  output: z.number(), // 输出 Token 成本 (积分)
  cacheWrite: z.number(), // 缓存写入成本 (积分)
  cacheRead: z.number(), // 缓存读取成本 (积分)
  search: z.number(), // 搜索成本 (积分)
  total: z.number(), // 总成本 (积分)
});

/**
 * AI 响应
 */
export const AIResponseSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  content: z.string(),
  modelUsed: z.string(),
  usage: TokenUsageSchema,
  cost: z.object({
    creditsDeducted: z.number(),
    costUsd: z.number(),
    costBreakdown: CostBreakdownSchema,
  }),
  stopReason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']).optional(),
  createdAt: z.string().datetime(),
});

// ============================================
// 流式响应事件类型
// ============================================

/**
 * SSE 事件类型
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  // 消息开始
  z.object({
    type: z.literal('message_start'),
    messageId: z.string().uuid(),
    conversationId: z.string().uuid(),
    modelUsed: z.string(),
  }),
  // 内容增量
  z.object({
    type: z.literal('content_delta'),
    delta: z.string(),
    index: z.number(),
  }),
  // 使用统计 (流结束时发送)
  z.object({
    type: z.literal('usage'),
    usage: TokenUsageSchema,
    cost: z.object({
      creditsDeducted: z.number(),
      costUsd: z.number(),
      costBreakdown: CostBreakdownSchema,
    }),
  }),
  // 消息结束
  z.object({
    type: z.literal('message_end'),
    stopReason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']),
  }),
  // 错误
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
  // Ping (保持连接)
  z.object({
    type: z.literal('ping'),
  }),
]);

// ============================================
// 模型配置类型
// ============================================

/**
 * 模型定价信息
 */
export const ModelPricingSchema = z.object({
  inputCostPer1M: z.number(), // 每百万输入 Token 成本 (美元)
  outputCostPer1M: z.number(), // 每百万输出 Token 成本 (美元)
  cacheWriteCostPer1M: z.number().optional(), // 缓存写入成本
  cacheReadCostPer1M: z.number().optional(), // 缓存读取成本
  searchCostPer1K: z.number().optional(), // 每千次搜索成本
});

/**
 * 模型信息
 */
export const ModelInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  modelId: z.string(), // Claude API 模型 ID
  provider: z.enum(['anthropic', 'openai', 'google', 'custom', 'builtin']),
  maxTokens: z.number(),
  inputLimit: z.number(),
  enableWebSearch: z.boolean(),
  pricing: ModelPricingSchema,
  isActive: z.boolean(),
});

// ============================================
// 导出 TypeScript 类型
// ============================================

export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type AIMessage = z.infer<typeof AIMessageSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type AIRequest = z.infer<typeof AIRequestSchema>;
export type StreamRequest = z.infer<typeof StreamRequestSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type AIResponse = z.infer<typeof AIResponseSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

// ============================================
// Claude API 原生类型 (用于内部处理)
// ============================================

/**
 * Claude API 消息格式
 */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

/**
 * Claude API 内容块
 */
export interface ClaudeContentBlock {
  type: 'text' | 'image' | 'document' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
  cache_control?: {
    type: 'ephemeral';
  };
}

/**
 * Claude API 响应 Usage
 */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Claude API 流事件
 */
export interface ClaudeStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: {
    id: string;
    model: string;
    usage?: ClaudeUsage;
  };
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}
