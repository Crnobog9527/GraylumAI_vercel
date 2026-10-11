/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContentErasureBody } from './content-erasure-dialog';
import type { ContentErasureState } from '@/hooks/use-content-erasure';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
vi.mock('@/components/ui/dialog', () => ({
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));

const id = '11111111-1111-4111-8111-111111111111';
const preview = {
  kind: 'answer' as const, id, alreadyDeleted: false, affectedExecutions: 1, preservedSavedVersions: 2,
  affectedSources: [], previewHash: 'b'.repeat(64),
};
const base: ContentErasureState = {
  preview: null, loading: false, previewError: '', confirming: false, message: '', messageTone: 'notice', finished: false,
};

function render(state: Partial<ContentErasureState>) {
  const handlers = { onConfirm: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  const tree = ContentErasureBody({ target: { kind: 'answer', id }, name: '这条回答', state: { ...base, ...state }, ...handlers });
  return { html: renderToStaticMarkup(tree), tree, ...handlers };
}

/** Finds rendered buttons by their visible label inside the returned element tree. */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  const own = typeof node.props.onClick === 'function' ? [node] : [];
  return [...own, ...buttons(node.props.children)];
}
function label(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(label).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? label(node.props.children) : '';
}
function button(tree: ReactNode, text: string) {
  const found = buttons(tree).find((element) => label(element.props.children).includes(text));
  if (!found) throw new Error('missing button ' + text);
  return found;
}

describe('ContentErasureBody', () => {
  it('shows a loading state and does not allow confirming before the preview arrives', () => {
    const view = render({ loading: true });
    expect(view.html).toContain('正在核对会删除哪些内容');
    expect(button(view.tree, '永久删除这条回答').props.disabled).toBe(true);
  });

  it('lists plain-language consequences and confirms only on the explicit button', () => {
    const view = render({ preview });
    expect(view.html).toContain('这条回答');
    expect(view.html).toContain('你的提问会保留');
    expect(view.html).toContain('来源已不可用');
    expect(view.html).toContain('无法恢复');
    // preservedSavedVersions is 2 here; the impact text must not promise that number (#766 P2).
    expect(view.html.replace(/<[^>]*>/g, '')).not.toMatch(/\d/);
    const confirm = button(view.tree, '永久删除这条回答');
    expect(confirm.props.disabled).toBe(false);
    confirm.props.onClick?.();
    expect(view.onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels without confirming', () => {
    const view = render({ preview });
    button(view.tree, '取消').props.onClick?.();
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(view.onConfirm).not.toHaveBeenCalled();
  });

  it('locks both actions while the deletion is in flight', () => {
    const view = render({ preview, confirming: true });
    expect(button(view.tree, '取消').props.disabled).toBe(true);
    expect(button(view.tree, '正在删除').props.disabled).toBe(true);
  });

  it('offers a retry instead of confirming when the preview failed', () => {
    const view = render({ previewError: '暂时无法读取删除影响，请稍后重试。' });
    expect(view.html).toContain('role="alert"');
    expect(() => button(view.tree, '永久删除这条回答')).toThrow();
    button(view.tree, '重新读取').props.onClick?.();
    expect(view.onRetry).toHaveBeenCalledOnce();
  });

  it('shows a confirm error next to the still-available confirmation', () => {
    const view = render({ preview, message: '这项内容正在使用中，本次没有删除任何内容。', messageTone: 'error' });
    expect(view.html).toContain('role="alert"');
    expect(button(view.tree, '永久删除这条回答').props.disabled).toBe(false);
  });

  it('after deletion shows the result and only a close button', () => {
    const view = render({ preview, finished: true, message: '已永久删除。', messageTone: 'done' });
    expect(view.html).toContain('已永久删除。');
    expect(view.html).not.toContain('删除影响');
    expect(() => button(view.tree, '取消')).toThrow();
    button(view.tree, '关闭').props.onClick?.();
    expect(view.onClose).toHaveBeenCalledOnce();
  });
});
