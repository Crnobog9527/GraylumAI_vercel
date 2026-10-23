/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ResultCardView, SaveReplyForm } from './session-results';
import type { SessionResultItem } from '@/lib/session-results';

vi.mock('@/trpc/client', () => ({ trpc: {} }));

const item: SessionResultItem = { id: 'a', familyId: 'a', version: 2, versions: 2, resultType: 'script', title: '早起口播稿',
  body: '今天早起……', sourceExecutionId: null, sourceAvailable: true, createdAt: '2026-10-23T00:00:00Z' };

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
const button = (tree: ReactNode, text: string) => {
  const found = buttons(tree).find(element => label(element.props.children).includes(text));
  if (!found) throw new Error('missing button ' + text);
  return found;
};
function card(props: Partial<Parameters<typeof ResultCardView>[0]>) {
  const handlers = { onMode: vi.fn(), onDraft: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() };
  const tree = ResultCardView({ item, mode: 'view', draft: { title: item.title, body: item.body }, error: '', pending: false,
    ...handlers, ...props });
  return { tree, html: renderToStaticMarkup(tree), ...handlers };
}

describe('session results panel', () => {
  it('shows the newest version with copy, edit, history and delete', () => {
    const view = card({});
    expect(view.html).toContain('早起口播稿');
    expect(view.html).toContain('第 2 版');
    button(view.tree, '编辑').props.onClick?.();
    expect(view.onMode).toHaveBeenCalledWith('edit');
    button(view.tree, '历史版本（2）').props.onClick?.();
    expect(view.onMode).toHaveBeenCalledWith('history');
    button(view.tree, '删除').props.onClick?.();
    expect(view.onMode).toHaveBeenCalledWith('delete');
  });
  it('asks before deleting and says the reply stays', () => {
    const view = card({ mode: 'delete' });
    expect(view.html).toContain('生成它的回复仍保留在对话里');
    button(view.tree, '确认删除').props.onClick?.();
    expect(view.onDelete).toHaveBeenCalledOnce();
  });
  it('edits in place and blocks a second click while saving', () => {
    const view = card({ mode: 'edit', pending: true });
    expect(view.html).toContain('aria-label="修改内容"');
    expect(button(view.tree, '保存修改').props.disabled).toBe(true);
  });
  it('lists older versions and marks an unavailable source', () => {
    const view = card({ mode: 'history', item: { ...item, sourceAvailable: false },
      versions: [item, { ...item, id: 'b', version: 1, body: '第一版' }] });
    expect(view.html).toContain('第一版');
    expect(view.html).toContain('生成它的回复已不可用');
  });
  it('shows a retry instead of endless loading when history cannot be read', () => {
    const onRetryHistory = vi.fn();
    const view = card({ mode: 'history', versions: undefined, historyError: true, onRetryHistory });
    expect(view.html).toContain('历史版本暂时读不出来');
    expect(view.html).not.toContain('正在读取历史版本');
    button(view.tree, '重试').props.onClick?.();
    expect(onRetryHistory).toHaveBeenCalledOnce();
  });
  it('save form offers every result type and shows refusals', () => {
    const handlers = { onType: vi.fn(), onTitle: vi.fn(), onText: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() };
    const tree = SaveReplyForm({ type: 'body', title: '', text: '原文', error: '只能保存回复里的原文', pending: false, ...handlers });
    const html = renderToStaticMarkup(tree);
    for (const text of ['口播稿', '分镜', '剪辑建议', '正文', '选题清单', '其他文案']) expect(html).toContain(text);
    expect(html).not.toContain('纪要');
    expect(html).toContain('只能保存回复里的原文');
    button(tree, '确认保存').props.onClick?.();
    expect(handlers.onConfirm).toHaveBeenCalledOnce();
  });
});
