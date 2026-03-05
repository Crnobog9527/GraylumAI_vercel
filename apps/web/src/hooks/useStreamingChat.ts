/**
 * useStreamingChat Hook
 *
 * 真正的流式 AI 对话 Hook
 * 实现打字机效果和中断保存
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase';

// Types
export interface StreamMessage {
  id: string;
  role: 'user' | 'assistant';
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
  };
}

export interface StreamingChatState {
  conversationId: string | null;
  messages: StreamMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  modelUsed: string | null;
}

interface StreamEvent {
  type: 'init' | 'delta' | 'complete' | 'error';
  conversationId?: string;
  modelUsed?: string;
  requestId?: string;
  content?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  cost?: {
    creditsDeducted: number;
    estimatedCredits: number;
    refunded: number;
  };
  error?: string;
}

interface UseStreamingChatOptions {
  conversationId?: string;
  onMessageStart?: () => void;
  onMessageComplete?: (message: StreamMessage) => void;
  onConversationCreated?: (conversationId: string) => void;
  onError?: (error: string) => void;
  onBalanceChange?: () => void;
}

// Supabase client for auth
const supabase = createClient();

export function useStreamingChat(options: UseStreamingChatOptions = {}) {
  const [state, setState] = useState<StreamingChatState>({
    conversationId: options.conversationId ?? null,
    messages: [],
    isLoading: false,
    isStreaming: false,
    error: null,
    modelUsed: null,
  });

  // Abort controller for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingMessageRef = useRef<string>('');

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  /**
   * Send message with streaming response
   */
  const sendMessage = useCallback(
    async (content: string, sendOptions: { modelId?: string } = {}) => {
      if (!content.trim() || state.isStreaming) return;

      // Get auth token
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setState((prev) => ({ ...prev, error: '未能获取身份证明，请刷新页面或重新登录' }));
        options.onError?.('未能获取身份证明，请刷新页面或重新登录');
        return;
      }

      // Create abort controller
      abortControllerRef.current = new AbortController();
      streamingMessageRef.current = '';

      // Add user message immediately
      const userMessage: StreamMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };

      // Add placeholder for assistant message
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: StreamMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        isStreaming: true,
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, assistantMessage],
        isLoading: true,
        isStreaming: true,
        error: null,
      }));

      options.onMessageStart?.();

      try {
        const response = await fetch('/api/ai/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            message: content.trim(),
            conversationId: state.conversationId,
            modelId: sendOptions.modelId,
            requestId: crypto.randomUUID(),
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let finalUsage: StreamEvent['usage'] | undefined;
        let finalCost: StreamEvent['cost'] | undefined;
        let finalConversationId: string | undefined;

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (!data) continue;

              try {
                const event: StreamEvent = JSON.parse(data);

                switch (event.type) {
                  case 'init':
                    finalConversationId = event.conversationId;
                    setState((prev) => ({
                      ...prev,
                      conversationId: event.conversationId ?? prev.conversationId,
                      modelUsed: event.modelUsed ?? prev.modelUsed,
                    }));
                    // Notify parent about new conversation
                    if (event.conversationId && !state.conversationId) {
                      options.onConversationCreated?.(event.conversationId);
                    }
                    break;

                  case 'delta':
                    if (event.content) {
                      streamingMessageRef.current += event.content;

                      // Update message content with typewriter effect
                      setState((prev) => ({
                        ...prev,
                        messages: prev.messages.map((m) =>
                          m.id === assistantMessageId
                            ? { ...m, content: streamingMessageRef.current }
                            : m
                        ),
                      }));
                    }
                    break;

                  case 'complete':
                    finalUsage = event.usage;
                    finalCost = event.cost;
                    finalConversationId = event.conversationId;
                    break;

                  case 'error':
                    throw new Error(event.error || 'Stream error');
                }
              } catch (parseError) {
                // Ignore parse errors for malformed events
                if (parseError instanceof Error && parseError.message !== 'Stream error') {
                  console.warn('Parse error:', parseError);
                } else {
                  throw parseError;
                }
              }
            }
          }
        }

        // Finalize assistant message
        const finalMessage: StreamMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: streamingMessageRef.current,
          createdAt: new Date().toISOString(),
          isStreaming: false,
          usage: finalUsage
            ? {
              inputTokens: finalUsage.inputTokens,
              outputTokens: finalUsage.outputTokens,
              cacheReadTokens: finalUsage.cacheReadTokens,
            }
            : undefined,
          cost: finalCost
            ? {
              credits: finalCost.creditsDeducted,
            }
            : undefined,
        };

        setState((prev) => ({
          ...prev,
          conversationId: finalConversationId ?? prev.conversationId,
          messages: prev.messages.map((m) =>
            m.id === assistantMessageId ? finalMessage : m
          ),
          isLoading: false,
          isStreaming: false,
        }));

        options.onMessageComplete?.(finalMessage);
        options.onBalanceChange?.();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // User aborted - finalize with partial content
          const partialMessage: StreamMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: streamingMessageRef.current + '\n\n[已中断]',
            createdAt: new Date().toISOString(),
            isStreaming: false,
          };

          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessageId ? partialMessage : m
            ),
            isLoading: false,
            isStreaming: false,
          }));

          options.onBalanceChange?.();
        } else {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';

          setState((prev) => ({
            ...prev,
            messages: prev.messages.filter((m) => m.id !== assistantMessageId),
            isLoading: false,
            isStreaming: false,
            error: errorMessage,
          }));

          options.onError?.(errorMessage);
        }
      } finally {
        abortControllerRef.current = null;
      }
    },
    [state.conversationId, state.isStreaming, options]
  );

  /**
   * Abort current streaming response
   */
  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  /**
   * Load conversation history
   */
  const loadHistory = useCallback(
    async (conversationId: string) => {
      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          throw new Error('Not authenticated');
        }

        const { data: messages, error } = await supabase
          .from('messages')
          .select('id, role, content, created_at')
          .eq('conversation_id', conversationId)
          .eq('is_deleted', 'false')
          .order('created_at', { ascending: true })
          .limit(50);

        if (error) throw error;

        setState((prev) => ({
          ...prev,
          conversationId,
          messages:
            messages?.map((m) => ({
              id: m.id,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              createdAt: m.created_at,
            })) ?? [],
          isLoading: false,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load history',
        }));
      }
    },
    []
  );

  /**
   * Clear current chat
   */
  const clearChat = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    streamingMessageRef.current = '';

    setState({
      conversationId: null,
      messages: [],
      isLoading: false,
      isStreaming: false,
      error: null,
      modelUsed: null,
    });
  }, []);

  /**
   * Regenerate last response
   */
  const regenerate = useCallback(async () => {
    const lastUserMessage = [...state.messages]
      .reverse()
      .find((m) => m.role === 'user');

    if (!lastUserMessage) return;

    // Remove last assistant message
    setState((prev) => ({
      ...prev,
      messages: prev.messages.slice(0, -1),
    }));

    // Resend
    await sendMessage(lastUserMessage.content);
  }, [state.messages, sendMessage]);

  return {
    // State
    conversationId: state.conversationId,
    messages: state.messages,
    isLoading: state.isLoading,
    isStreaming: state.isStreaming,
    error: state.error,
    modelUsed: state.modelUsed,

    // Actions
    sendMessage,
    abort,
    loadHistory,
    clearChat,
    regenerate,
  };
}

export default useStreamingChat;
