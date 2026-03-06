/**
 * useAIChat Hook
 *
 * AI 对话核心 Hook
 * 管理对话状态、发送消息、流式响应
 *
 * @deprecated 旧非流式对话链路。请使用 useStreamingChat + /api/ai/stream。
 */

import { useState, useCallback, useRef } from 'react';
import { trpc } from '@/trpc/client';

// ============================================
// 类型定义
// ============================================

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  isStreaming?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
  };
  cost?: {
    credits: number;
    costUsd: number;
  };
}

export interface ChatState {
  conversationId: string | null;
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  error: Error | null;
  modelUsed: string | null;
  /** 当前请求的追踪信息 (用于中断结算) */
  currentRequest: {
    requestId: string;
    preDeductId: string;
    modelId: string;
    inputTokens: number;
    receivedContent: string;
  } | null;
}

export interface SendMessageOptions {
  modelId?: string;
  enableWebSearch?: boolean;
}

export interface UseAIChatOptions {
  conversationId?: string;
  onMessageStart?: (messageId: string) => void;
  onMessageComplete?: (message: Message) => void;
  onError?: (error: Error) => void;
}

// ============================================
// Hook 实现
// ============================================

export function useAIChat(options: UseAIChatOptions = {}) {
  const utils = trpc.useUtils();

  // 状态
  const [state, setState] = useState<ChatState>({
    conversationId: options.conversationId ?? null,
    messages: [],
    isLoading: false,
    isStreaming: false,
    error: null,
    modelUsed: null,
    currentRequest: null,
  });

  // Abort controller for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);

  // 发送消息 mutation
  const sendMessageMutation = trpc.ai.sendMessage.useMutation({
    onSuccess: (data) => {
      // 添加助手消息
      const assistantMessage: Message = {
        id: data.messageId,
        role: 'assistant',
        content: data.content,
        createdAt: data.createdAt,
        usage: data.usage,
        cost: {
          credits: data.cost.creditsDeducted,
          costUsd: data.cost.costUsd,
        },
      };

      setState((prev) => ({
        ...prev,
        conversationId: data.conversationId,
        messages: [...prev.messages, assistantMessage],
        isLoading: false,
        modelUsed: data.modelUsed,
        error: null,
      }));

      options.onMessageComplete?.(assistantMessage);

      // 刷新余额
      utils.credits.getBalance.invalidate();
    },
    onError: (error) => {
      // 将 tRPC 错误转换为标准 Error 对象
      const errorObj = new Error(error.message);
      errorObj.name = 'TRPCError';
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorObj,
      }));
      options.onError?.(errorObj);
    },
  });

  // 成本估算 query
  const estimateCostQuery = trpc.ai.estimateCost.useQuery;

  /**
   * 发送消息
   */
  const sendMessage = useCallback(
    async (content: string, sendOptions: SendMessageOptions = {}) => {
      if (!content.trim()) return;

      // 添加用户消息
      const userMessage: Message = {
        id: `temp-${Date.now()}`,
        role: 'user',
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isLoading: true,
        error: null,
      }));

      options.onMessageStart?.(userMessage.id);

      // 发送请求
      try {
        await sendMessageMutation.mutateAsync({
          message: content.trim(),
          conversationId: state.conversationId ?? undefined,
          modelId: sendOptions.modelId,
          enableWebSearch: sendOptions.enableWebSearch,
        });
      } catch {
        // 错误已在 mutation onError 处理
      }
    },
    [state.conversationId, sendMessageMutation, options]
  );

  /**
   * 估算消息成本
   */
  const estimateCost = useCallback(
    async (message: string, modelId?: string) => {
      const result = await utils.ai.estimateCost.fetch({
        message,
        conversationId: state.conversationId ?? undefined,
        modelId,
      });
      return result;
    },
    [state.conversationId, utils.ai.estimateCost]
  );

  // 中断请求 mutation
  const abortRequestMutation = trpc.ai.abortRequest.useMutation({
    onSuccess: () => {
      // 刷新余额
      utils.credits.getBalance.invalidate();
    },
  });

  /**
   * 中断响应并结算已消耗的 tokens
   */
  const abort = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // 如果有当前请求信息，进行中断结算
    const currentRequest = state.currentRequest;
    if (currentRequest) {
      try {
        // 估算已接收内容的 tokens (约 4 字符/token)
        const estimatedOutputTokens = Math.ceil(currentRequest.receivedContent.length / 4);

        await abortRequestMutation.mutateAsync({
          requestId: currentRequest.requestId,
          preDeductId: currentRequest.preDeductId,
          consumedTokens: {
            inputTokens: currentRequest.inputTokens,
            outputTokens: estimatedOutputTokens,
          },
          modelId: currentRequest.modelId,
          reason: '用户中断',
        });
      } catch (error) {
        console.error('Failed to settle abort:', error);
      }
    }

    setState((prev) => ({
      ...prev,
      isLoading: false,
      isStreaming: false,
      currentRequest: null,
    }));
  }, [state.currentRequest, abortRequestMutation]);

  /**
   * 加载对话历史
   */
  const loadHistory = useCallback(
    async (conversationId: string) => {
      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        const messages = await utils.ai.getConversationMessages.fetch({
          conversationId,
          limit: 50,
        });

        setState((prev) => ({
          ...prev,
          conversationId,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            createdAt: m.created_at,
          })),
          isLoading: false,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: error as Error,
        }));
      }
    },
    [utils.ai.getConversationMessages]
  );

  /**
   * 清空对话
   */
  const clearChat = useCallback(() => {
    setState({
      conversationId: null,
      messages: [],
      isLoading: false,
      isStreaming: false,
      error: null,
      modelUsed: null,
      currentRequest: null,
    });
  }, []);

  /**
   * 重新生成最后一条回复
   */
  const regenerate = useCallback(async () => {
    const lastUserMessage = [...state.messages]
      .reverse()
      .find((m) => m.role === 'user');

    if (!lastUserMessage) return;

    // 移除最后的助手消息
    setState((prev) => ({
      ...prev,
      messages: prev.messages.filter(
        (m) => m.role !== 'assistant' || m !== prev.messages[prev.messages.length - 1]
      ),
    }));

    // 重新发送
    await sendMessage(lastUserMessage.content);
  }, [state.messages, sendMessage]);

  /**
   * 删除消息
   */
  const deleteMessage = useCallback((messageId: string) => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.filter((m) => m.id !== messageId),
    }));
  }, []);

  return {
    // 状态
    conversationId: state.conversationId,
    messages: state.messages,
    isLoading: state.isLoading,
    isStreaming: state.isStreaming,
    error: state.error,
    modelUsed: state.modelUsed,

    // 操作
    sendMessage,
    estimateCost,
    abort,
    loadHistory,
    clearChat,
    regenerate,
    deleteMessage,
  };
}

export default useAIChat;
