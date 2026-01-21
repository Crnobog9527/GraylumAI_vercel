/**
 * useStreamResponse Hook
 *
 * 处理 SSE 流式响应
 * 支持实时内容更新、中断、错误恢复
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ============================================
// 类型定义
// ============================================

export interface StreamEvent {
  type: 'message_start' | 'content_delta' | 'usage' | 'message_end' | 'error' | 'ping';
  messageId?: string;
  conversationId?: string;
  modelUsed?: string;
  delta?: string;
  index?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  cost?: {
    creditsDeducted: number;
    costUsd: number;
    costBreakdown: {
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      search: number;
      total: number;
    };
  };
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface StreamState {
  content: string;
  isStreaming: boolean;
  error: Error | null;
  messageId: string | null;
  modelUsed: string | null;
  usage: StreamEvent['usage'] | null;
  cost: StreamEvent['cost'] | null;
  stopReason: StreamEvent['stopReason'] | null;
}

export interface UseStreamResponseOptions {
  onStart?: (event: StreamEvent) => void;
  onDelta?: (delta: string, fullContent: string) => void;
  onComplete?: (state: StreamState) => void;
  onError?: (error: Error) => void;
}

// ============================================
// Hook 实现
// ============================================

export function useStreamResponse(options: UseStreamResponseOptions = {}) {
  const [state, setState] = useState<StreamState>({
    content: '',
    isStreaming: false,
    error: null,
    messageId: null,
    modelUsed: null,
    usage: null,
    cost: null,
    stopReason: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  /**
   * 解析 SSE 事件
   */
  const parseSSEEvent = useCallback((line: string): StreamEvent | null => {
    if (!line.startsWith('data: ')) return null;

    try {
      const data = line.slice(6); // Remove 'data: '
      return JSON.parse(data) as StreamEvent;
    } catch {
      return null;
    }
  }, []);

  /**
   * 处理流事件
   */
  const handleEvent = useCallback(
    (event: StreamEvent) => {
      switch (event.type) {
        case 'message_start':
          setState((prev) => ({
            ...prev,
            messageId: event.messageId ?? null,
            modelUsed: event.modelUsed ?? null,
          }));
          options.onStart?.(event);
          break;

        case 'content_delta':
          if (event.delta) {
            setState((prev) => {
              const newContent = prev.content + event.delta;
              options.onDelta?.(event.delta!, newContent);
              return { ...prev, content: newContent };
            });
          }
          break;

        case 'usage':
          setState((prev) => ({
            ...prev,
            usage: event.usage ?? null,
            cost: event.cost ?? null,
          }));
          break;

        case 'message_end':
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            stopReason: event.stopReason ?? null,
          }));
          break;

        case 'error':
          const error = new Error(event.message ?? 'Stream error');
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            error,
          }));
          options.onError?.(error);
          break;

        case 'ping':
          // Keep-alive, do nothing
          break;
      }
    },
    [options]
  );

  /**
   * 开始流式请求
   */
  const startStream = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      // 重置状态
      setState({
        content: '',
        isStreaming: true,
        error: null,
        messageId: null,
        modelUsed: null,
        usage: null,
        cost: null,
        stopReason: null,
      });

      // 创建 abort controller
      abortControllerRef.current = new AbortController();

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        if (!response.body) {
          throw new Error('No response body');
        }

        // 读取流
        const reader = response.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const event = parseSSEEvent(line);
            if (event) {
              handleEvent(event);
            }
          }
        }

        // 处理最后的 buffer
        if (buffer) {
          const event = parseSSEEvent(buffer);
          if (event) {
            handleEvent(event);
          }
        }

        // 完成回调
        setState((prev) => {
          options.onComplete?.(prev);
          return prev;
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          // 用户中断，不是错误
          setState((prev) => ({ ...prev, isStreaming: false }));
        } else {
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            error: error as Error,
          }));
          options.onError?.(error as Error);
        }
      } finally {
        abortControllerRef.current = null;
        readerRef.current = null;
      }
    },
    [parseSSEEvent, handleEvent, options]
  );

  /**
   * 中断流
   */
  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (readerRef.current) {
      readerRef.current.cancel();
    }
    setState((prev) => ({ ...prev, isStreaming: false }));
  }, []);

  /**
   * 重置状态
   */
  const reset = useCallback(() => {
    abort();
    setState({
      content: '',
      isStreaming: false,
      error: null,
      messageId: null,
      modelUsed: null,
      usage: null,
      cost: null,
      stopReason: null,
    });
  }, [abort]);

  // 清理
  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  return {
    // 状态
    content: state.content,
    isStreaming: state.isStreaming,
    error: state.error,
    messageId: state.messageId,
    modelUsed: state.modelUsed,
    usage: state.usage,
    cost: state.cost,
    stopReason: state.stopReason,

    // 操作
    startStream,
    abort,
    reset,
  };
}

export default useStreamResponse;
