'use client';

/**
 * MessageStream Component
 *
 * 流式消息渲染组件
 * 支持打字机效果、代码高亮、Markdown 渲染
 */

import React, { useState, useEffect, useMemo } from 'react';
import { escapeHtml, simpleMarkdown } from './messageSanitization';

// ============================================
// 类型定义
// ============================================

interface MessageStreamProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
  enableMarkdown?: boolean;
  enableCodeHighlight?: boolean;
  typingSpeed?: number; // 毫秒/字符，0 表示立即显示
}

// ============================================
// 组件实现
// ============================================

export function MessageStream({
  content,
  isStreaming = false,
  className = '',
  enableMarkdown = true,
  typingSpeed = 0,
}: MessageStreamProps) {
  const [displayedContent, setDisplayedContent] = useState(content);
  const [cursorVisible, setCursorVisible] = useState(true);

  // 打字机效果
  useEffect(() => {
    if (typingSpeed > 0 && content.length > displayedContent.length) {
      const timer = setTimeout(() => {
        setDisplayedContent(content.slice(0, displayedContent.length + 1));
      }, typingSpeed);
      return () => clearTimeout(timer);
    } else {
      setDisplayedContent(content);
    }
  }, [content, displayedContent, typingSpeed]);

  // 闪烁光标
  useEffect(() => {
    if (!isStreaming) {
      setCursorVisible(false);
      return;
    }

    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 500);

    return () => clearInterval(timer);
  }, [isStreaming]);

  // 渲染内容
  const renderedContent = useMemo(() => {
    if (enableMarkdown) {
      return simpleMarkdown(displayedContent);
    }
    return escapeHtml(displayedContent).replace(/\n/g, '<br />');
  }, [displayedContent, enableMarkdown]);

  return (
    <div className={`message-stream ${className}`}>
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: renderedContent }}
      />

      {/* 流式光标 */}
      {isStreaming && (
        <span
          className={`inline-block w-2 h-4 bg-current ml-1 transition-opacity ${
            cursorVisible ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default MessageStream;
