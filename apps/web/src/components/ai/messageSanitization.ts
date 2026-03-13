/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

/**
 * HTML 转义
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

export function sanitizeUrl(rawUrl: string): string {
  const value = rawUrl.trim();

  if (value.startsWith('/') || value.startsWith('#')) {
    return escapeHtml(value);
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return escapeHtml(value);
    }
  } catch {
    return '#';
  }

  return '#';
}

/**
 * 简单的 Markdown 转 HTML
 * 支持: 粗体、斜体、代码块、行内代码、链接
 */
export function simpleMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(
      `<pre class="bg-muted rounded-md p-3 my-2 overflow-x-auto"><code class="language-${escapeHtml(lang || 'text')}">${escapeHtml(code.trim())}</code></pre>`
    );
    return placeholder;
  });

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code class="bg-muted px-1 rounded">${escapeHtml(code)}</code>`);
    return placeholder;
  });

  text = escapeHtml(text);

  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) =>
      `<a href="${sanitizeUrl(href)}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">${label}</a>`
  );

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\n/g, '<br />');

  inlineCodes.forEach((html, index) => {
    text = text.replace(`__INLINE_CODE_${index}__`, html);
  });

  codeBlocks.forEach((html, index) => {
    text = text.replace(`__CODE_BLOCK_${index}__`, html);
  });

  return text;
}
