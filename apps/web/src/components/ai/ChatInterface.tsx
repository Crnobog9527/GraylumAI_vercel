'use client';

/**
 * ChatInterface Component
 *
 * AI 对话界面主组件
 * 包含消息列表、输入框、发送按钮
 *
 * @deprecated 旧非流式对话 UI。请使用 apps/web/src/app/chat/page.tsx 主链路。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useAIChat, type Message } from '@/hooks/useAIChat';
import { MessageStream } from './MessageStream';
import { TokenUsageDisplay } from './TokenUsageDisplay';
import { InterruptButton } from './InterruptButton';

// ============================================
// 类型定义
// ============================================

interface ChatInterfaceProps {
  conversationId?: string;
  className?: string;
  placeholder?: string;
  onConversationStart?: (conversationId: string) => void;
  onError?: (error: Error) => void;
}

// ============================================
// 子组件
// ============================================

interface MessageBubbleProps {
  message: Message;
  onDelete?: () => void;
}

function MessageBubble({ message, onDelete }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 group`}
    >
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        {/* 消息内容 */}
        <div className="whitespace-pre-wrap break-words">
          {message.isStreaming ? (
            <MessageStream content={message.content} isStreaming />
          ) : (
            message.content
          )}
        </div>

        {/* 使用统计 (仅助手消息) */}
        {!isUser && message.usage && (
          <div className="mt-2 pt-2 border-t border-border/50">
            <TokenUsageDisplay
              usage={message.usage}
              cost={message.cost}
              compact
            />
          </div>
        )}

        {/* 删除按钮 */}
        {onDelete && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 transition-opacity absolute -right-8 top-2 text-muted-foreground hover:text-destructive"
            aria-label="删除消息"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================
// 主组件
// ============================================

export function ChatInterface({
  conversationId: initialConversationId,
  className = '',
  placeholder = '输入消息...',
  onConversationStart,
  onError,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    conversationId,
    messages,
    isLoading,
    isStreaming,
    error,
    sendMessage,
    abort,
    clearChat,
    regenerate,
    deleteMessage,
  } = useAIChat({
    conversationId: initialConversationId,
    onMessageComplete: (message) => {
      // 对话开始时通知父组件
      if (conversationId && onConversationStart) {
        onConversationStart(conversationId);
      }
    },
    onError,
  });

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 处理发送
  const handleSend = useCallback(() => {
    if (!input.trim() || isLoading) return;

    sendMessage(input);
    setInput('');
  }, [input, isLoading, sendMessage]);

  // 处理键盘事件
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // 自动调整输入框高度
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);

      // 重置高度以获取正确的 scrollHeight
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
    },
    []
  );

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>开始新对话</p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onDelete={() => deleteMessage(message.id)}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm">
          {error.message}
          <button
            onClick={() => regenerate()}
            className="ml-2 underline hover:no-underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 操作栏 */}
      <div className="border-t border-border px-4 py-2 flex items-center gap-2">
        {/* 清空按钮 */}
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors"
            title="清空对话"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        )}

        {/* 重新生成按钮 */}
        {messages.length > 0 && !isLoading && (
          <button
            onClick={regenerate}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors"
            title="重新生成"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        )}

        {/* 中断按钮 */}
        {(isLoading || isStreaming) && <InterruptButton onInterrupt={abort} />}
      </div>

      {/* 输入区域 */}
      <div className="border-t border-border p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isLoading}
            className="flex-1 resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            rows={1}
            style={{ minHeight: '48px', maxHeight: '200px' }}
          />

          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="flex items-center justify-center w-12 h-12 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* 提示文字 */}
        <p className="text-xs text-muted-foreground mt-2">
          按 Enter 发送，Shift + Enter 换行
        </p>
      </div>
    </div>
  );
}

export default ChatInterface;
