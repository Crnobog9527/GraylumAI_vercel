/**
 * Stream Handler
 *
 * SSE (Server-Sent Events) 流式响应处理器
 * 处理 OpenRouter / OpenAI-compatible 流式响应并转换为前端友好格式
 */

import type { ClaudeMessage, TokenUsage, StreamEvent } from '../types/ai';
import {
  getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders,
  normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi,
} from './providerUtils';

type MessageEndEvent = Extract<StreamEvent, { type: 'message_end' }>;

// ============================================
// 常量
// ============================================

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const STREAM_HANDLER_PUBLIC_ERROR_MESSAGE = 'AI 响应生成失败，请稍后重试';
const STREAM_HANDLER_PROVIDER_FAILURE_MESSAGE = '上游 AI 服务请求失败';
const STREAM_HANDLER_EMPTY_RESPONSE_MESSAGE = '上游 AI 服务未返回响应体';

/**
 * SSE 事件类型
 */
const SSE_EVENTS = {
  MESSAGE_START: 'message_start',
  CONTENT_DELTA: 'content_delta',
  USAGE: 'usage',
  MESSAGE_END: 'message_end',
  ERROR: 'error',
  PING: 'ping',
} as const;

// ============================================
// 类型定义
// ============================================

export interface StreamRequestParams {
  model: string;
  messages: ClaudeMessage[];
  system?: string;
  apiEndpoint?: string | null;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

export interface StreamCallbacks {
  onStart?: (messageId: string, model: string) => void;
  onDelta?: (delta: string, index: number) => void;
  onUsage?: (usage: TokenUsage) => void;
  onEnd?: (stopReason: string) => void;
  onError?: (error: Error) => void;
}

export interface StreamResult {
  content: string;
  usage: TokenUsage;
  stopReason: string;
  messageId?: string;
}

// ============================================
// SSE 解析器
// ============================================

/**
 * 解析 SSE 数据行
 */
function parseSSELine(line: string): { event?: string; data?: string } | null {
  if (!line || line.startsWith(':')) {
    return null;
  }

  if (line.startsWith('event: ')) {
    return { event: line.slice(7) };
  }

  if (line.startsWith('data: ')) {
    return { data: line.slice(6) };
  }

  return null;
}

// ============================================
// Stream Handler 类
// ============================================

export class StreamHandler {
  private apiKey: string;
  private abortController: AbortController | null = null;

  constructor(apiKey?: string) {
    this.apiKey = getConfiguredProviderApiKey(apiKey) ?? '';
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY not configured');
    }
  }

  /**
   * 发起流式请求
   */
  async stream(
    params: StreamRequestParams,
    callbacks: StreamCallbacks = {}
  ): Promise<StreamResult> {
    this.abortController = new AbortController();

    const result: StreamResult = {
      content: '',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      stopReason: 'end_turn',
    };

    try {
      const endpoint = usesOpenAICompatibleApi({
        endpoint: params.apiEndpoint,
        apiKey: this.apiKey,
      })
        ? (normalizeOpenAICompatibleEndpoint(params.apiEndpoint) || OPENROUTER_API_URL)
        : OPENROUTER_API_URL;

      callbacks.onStart?.(`openrouter-${Date.now()}`, params.model);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: getOpenAICompatibleHeaders(this.apiKey),
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            ...(params.system ? [{ role: 'system', content: params.system }] : []),
            ...params.messages,
          ],
          temperature: params.temperature,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(STREAM_HANDLER_PROVIDER_FAILURE_MESSAGE);
      }

      if (!response.body) {
        throw new Error(STREAM_HANDLER_EMPTY_RESPONSE_MESSAGE);
      }

      // 处理流式响应
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let deltaIndex = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const parsed = parseSSELine(line);

          if (!parsed) continue;

          if (parsed.data && parsed.data !== '[DONE]') {
            try {
              const event = JSON.parse(parsed.data) as {
                choices?: Array<{
                  delta?: { content?: string };
                  finish_reason?: string | null;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                };
              };
              const delta = event.choices?.[0]?.delta?.content ?? '';

              if (delta) {
                result.content += delta;
                callbacks.onDelta?.(delta, deltaIndex);
                deltaIndex++;
              }

              if (event.usage) {
                result.usage.inputTokens = event.usage.prompt_tokens ?? result.usage.inputTokens;
                result.usage.outputTokens = event.usage.completion_tokens ?? result.usage.outputTokens;
                callbacks.onUsage?.(result.usage);
              }

              const finishReason = event.choices?.[0]?.finish_reason;
              if (finishReason) {
                result.stopReason = finishReason === 'length'
                  ? 'max_tokens'
                  : finishReason === 'tool_calls'
                    ? 'tool_use'
                    : 'end_turn';
              }
            } catch {
              // Ignore malformed provider keepalive frames.
            }
          }
        }
      }

      callbacks.onEnd?.(result.stopReason);
      return result;
    } catch (error) {
      if (error instanceof Error) {
        callbacks.onError?.(error);
      }
      throw error;
    }
  }

  /**
   * 中断流
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

// ============================================
// SSE 响应构建器 (用于 tRPC 流式响应)
// ============================================

/**
 * 创建 SSE 格式的事件字符串
 */
export function formatSSEEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 创建 SSE 响应流
 */
export function createSSEStream(
  params: StreamRequestParams,
  options: {
    messageId: string;
    conversationId: string;
    onComplete?: (result: StreamResult) => void;
  }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const handler = new StreamHandler();

  return new ReadableStream({
    async start(controller) {
      try {
        // 发送开始事件
        const startEvent: StreamEvent = {
          type: 'message_start',
          messageId: options.messageId,
          conversationId: options.conversationId,
          modelUsed: params.model,
        };
        controller.enqueue(encoder.encode(formatSSEEvent(startEvent)));

        // 处理流
        const result = await handler.stream(params, {
          onDelta: (delta, index) => {
            const deltaEvent: StreamEvent = {
              type: 'content_delta',
              delta,
              index,
            };
            controller.enqueue(encoder.encode(formatSSEEvent(deltaEvent)));
          },
          onUsage: (usage) => {
            // Usage 在结束时发送
          },
          onError: (error) => {
            const errorEvent: StreamEvent = {
              type: 'error',
              code: 'STREAM_ERROR',
              message: STREAM_HANDLER_PUBLIC_ERROR_MESSAGE,
              retryable: true,
            };
            controller.enqueue(encoder.encode(formatSSEEvent(errorEvent)));
          },
        });

        // 发送使用统计
        const usageEvent: StreamEvent = {
          type: 'usage',
          usage: result.usage,
          cost: {
            creditsDeducted: 0, // 由调用方计算
            costUsd: 0,
            costBreakdown: {
              input: 0,
              output: 0,
              cacheWrite: 0,
              cacheRead: 0,
              search: 0,
              total: 0,
            },
          },
        };
        controller.enqueue(encoder.encode(formatSSEEvent(usageEvent)));

        // 发送结束事件
        const endEvent: StreamEvent = {
          type: 'message_end',
          stopReason: result.stopReason as MessageEndEvent['stopReason'],
        };
        controller.enqueue(encoder.encode(formatSSEEvent(endEvent)));

        // 回调
        options.onComplete?.(result);

        controller.close();
      } catch (error) {
        const errorEvent: StreamEvent = {
          type: 'error',
          code: 'STREAM_ERROR',
          message: STREAM_HANDLER_PUBLIC_ERROR_MESSAGE,
          retryable: false,
        };
        controller.enqueue(encoder.encode(formatSSEEvent(errorEvent)));
        controller.close();
      }
    },

    cancel() {
      handler.abort();
    },
  });
}

/**
 * 创建 Ping 事件 (保持连接)
 */
export function createPingEvent(): string {
  const pingEvent: StreamEvent = { type: 'ping' };
  return formatSSEEvent(pingEvent);
}

/**
 * 创建错误事件
 */
export function createErrorEvent(
  code: string,
  message: string,
  retryable: boolean = false
): string {
  const errorEvent: StreamEvent = {
    type: 'error',
    code,
    message,
    retryable,
  };
  return formatSSEEvent(errorEvent);
}

export default StreamHandler;
