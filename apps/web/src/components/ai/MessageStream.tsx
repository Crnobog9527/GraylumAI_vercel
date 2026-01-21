'use client';

/**
 * MessageStream Component
 *
 * 流式消息渲染组件
 * 支持打字机效果、代码高亮、Markdown 渲染
 */

import React, { useState, useEffect, useMemo } from 'react';

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
// 工具函数
// ============================================

/**
 * 简单的 Markdown 转 HTML
 * 支持: 粗体、斜体、代码块、行内代码、链接
 */
function simpleMarkdown(text: string): string {
  // 代码块
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="bg-muted rounded-md p-3 my-2 overflow-x-auto"><code class="language-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>`;
  });

  // 行内代码
  text = text.replace(/`([^`]+)`/g, '<code class="bg-muted px-1 rounded">$1</code>');

  // 粗体
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 斜体
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 链接
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">$1</a>'
  );

  // 换行
  text = text.replace(/\n/g, '<br />');

  return text;
}

/**
 * HTML 转义
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
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
