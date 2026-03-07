/**
 * Token Counter Service
 *
 * Token 计数服务
 * 支持官方 API 精确计数和本地快速估算
 */

import type { AIMessage } from '../types/ai';
import { getFallbackProviderApiKey, looksLikeOpenRouterKey } from './providerUtils';

// ============================================
// 常量
// ============================================

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 本地估算的字符/Token 比率
 * 中文约 1.5 字符/Token，英文约 4 字符/Token
 * 取平均值进行估算
 */
const CHARS_PER_TOKEN = {
  chinese: 1.5,
  english: 4,
  mixed: 2.5, // 混合文本
};

// ============================================
// 类型定义
// ============================================

export interface TokenCountParams {
  model: string;
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
  breakdown?: {
    messages: number;
    system: number;
    tools: number;
  };
}

// ============================================
// 官方 API 计数
// ============================================

/**
 * 使用官方 count_tokens API 精确计算
 * @see https://docs.anthropic.com/en/docs/build-with-claude/token-counting
 */
export async function countTokensOfficial(params: TokenCountParams): Promise<number> {
  const apiKey = getFallbackProviderApiKey();

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY / ANTHROPIC_API_KEY not configured');
  }

  if (looksLikeOpenRouterKey(apiKey)) {
    throw new Error('Official token counting requires ANTHROPIC_API_KEY; OpenRouter keys fall back to estimate mode');
  }

  const response = await fetch(COUNT_TOKENS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      system: params.system,
      tools: params.tools,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token counting failed: ${error}`);
  }

  const data = await response.json() as { input_tokens: number };
  return data.input_tokens;
}

// ============================================
// 本地估算
// ============================================

/**
 * 检测文本语言类型
 */
function detectLanguage(text: string): 'chinese' | 'english' | 'mixed' {
  // 统计中文字符比例
  const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const totalChars = text.length;

  if (totalChars === 0) return 'english';

  const chineseRatio = chineseChars / totalChars;

  if (chineseRatio > 0.5) return 'chinese';
  if (chineseRatio < 0.1) return 'english';
  return 'mixed';
}

/**
 * 估算字符串的 Token 数
 */
export function estimateTokensFromString(text: string): number {
  if (!text) return 0;

  const language = detectLanguage(text);
  const charsPerToken = CHARS_PER_TOKEN[language];

  return Math.ceil(text.length / charsPerToken);
}

/**
 * 估算消息的 Token 数
 */
export function estimateTokensFromMessage(message: AIMessage): number {
  let tokens = 0;

  // Role overhead (approximately 4 tokens per message)
  tokens += 4;

  if (typeof message.content === 'string') {
    tokens += estimateTokensFromString(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && 'text' in block) {
        tokens += estimateTokensFromString(block.text as string);
      } else if (block.type === 'image') {
        // 图片按固定 Token 数估算 (取决于分辨率)
        tokens += 1000; // 平均估算
      } else if (block.type === 'document') {
        // PDF 文档按页数估算
        tokens += 2000; // 平均每页
      }
    }
  }

  return tokens;
}

/**
 * 估算消息列表的 Token 数
 */
export function estimateTokensFromMessages(messages: AIMessage[]): number {
  let total = 0;

  for (const message of messages) {
    total += estimateTokensFromMessage(message);
  }

  // 添加格式开销 (约 3-5 tokens)
  total += 5;

  return total;
}

/**
 * 估算系统提示词的 Token 数
 */
export function estimateSystemTokens(systemPrompt?: string): number {
  if (!systemPrompt) return 0;

  // System prompt overhead
  return estimateTokensFromString(systemPrompt) + 10;
}

/**
 * 估算工具定义的 Token 数
 */
export function estimateToolsTokens(tools?: TokenCountParams['tools']): number {
  if (!tools || tools.length === 0) return 0;

  let total = 0;

  for (const tool of tools) {
    // 工具名称和描述
    total += estimateTokensFromString(tool.name);
    total += estimateTokensFromString(tool.description);

    // 输入 schema (JSON 序列化后估算)
    const schemaStr = JSON.stringify(tool.input_schema);
    total += estimateTokensFromString(schemaStr);

    // 工具格式开销
    total += 20;
  }

  return total;
}

// ============================================
// 统一入口
// ============================================

/**
 * 计算 Token 数 (带降级)
 *
 * 优先使用官方 API，失败时降级到本地估算
 */
export async function countTokens(
  params: TokenCountParams,
  options: {
    useOfficial?: boolean;
    fallbackToEstimate?: boolean;
  } = {}
): Promise<TokenCountResult> {
  const { useOfficial = true, fallbackToEstimate = true } = options;

  // 尝试官方 API
  if (useOfficial) {
    try {
      const inputTokens = await countTokensOfficial(params);
      return {
        inputTokens,
        method: 'official',
      };
    } catch (error) {
      console.warn('Official token counting failed, falling back to estimate:', error);

      if (!fallbackToEstimate) {
        throw error;
      }
    }
  }

  // 本地估算
  const messagesTokens = params.messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(b => ('text' in b ? b.text : '')).join('');
    return sum + estimateTokensFromString(content) + 4; // +4 for role overhead
  }, 0);

  const systemTokens = estimateSystemTokens(params.system);
  const toolsTokens = estimateToolsTokens(params.tools);

  return {
    inputTokens: messagesTokens + systemTokens + toolsTokens,
    method: 'estimate',
    breakdown: {
      messages: messagesTokens,
      system: systemTokens,
      tools: toolsTokens,
    },
  };
}

/**
 * 快速估算 (仅本地，不调用 API)
 * 用于 UI 预览
 */
export function quickEstimate(text: string): number {
  return estimateTokensFromString(text);
}

/**
 * 估算输出 Token 数
 * 基于输入长度和任务类型
 */
export function estimateOutputTokens(
  inputTokens: number,
  taskType: 'chat' | 'coding' | 'summary' | 'translation' = 'chat'
): number {
  const ratios: Record<string, number> = {
    chat: 0.5, // 对话通常输出较短
    coding: 1.5, // 代码可能较长
    summary: 0.3, // 摘要较短
    translation: 1.0, // 翻译约等长
  };

  const ratio = ratios[taskType] ?? 0.5;
  const estimated = Math.ceil(inputTokens * ratio);

  // 限制在合理范围内
  return Math.max(100, Math.min(4096, estimated));
}

export default {
  countTokens,
  countTokensOfficial,
  quickEstimate,
  estimateTokensFromString,
  estimateTokensFromMessages,
  estimateOutputTokens,
};
