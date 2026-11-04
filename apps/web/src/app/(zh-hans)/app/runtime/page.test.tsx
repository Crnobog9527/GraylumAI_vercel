/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({ session: '', view: { data: undefined as unknown, error: undefined as unknown, refetch: () => Promise.resolve() } }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (key: string) => (key === 'session' ? h.session : null) }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/trpc/client', () => ({ trpc: { runtime: { view: { useQuery: () => h.view } } } }));
vi.mock('./turn-workspace', () => ({ TurnWorkspace: ({ sessionId }: { sessionId: string }) => <p>turn:{sessionId}</p> }));
vi.mock('./work-item-workspace', () => ({ WorkItemWorkspace: ({ workItemId }: { workItemId: string }) => <p>work:{workItemId}</p> }));
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: ({ children }: { children: React.ReactNode }) => <div data-frame>{children}</div> }));
import RuntimePage from './page';

beforeEach(() => { h.session = 's1'; h.view = { data: undefined, error: undefined, refetch: () => Promise.resolve() }; });

it('opens a free conversation and a work item in the turn workspaces once the scope is read', () => {
  h.view.data = { scope: { kind: 'positioning_draft' } };
  expect(renderToStaticMarkup(<RuntimePage />)).toContain('turn:s1');
  h.view.data = { scope: { kind: 'work_item', workItemId: 'w1' } };
  expect(renderToStaticMarkup(<RuntimePage />)).toContain('work:w1');
});

it('renders no workspace before the scope has been read', () => {
  const html = renderToStaticMarkup(<RuntimePage />);
  expect(html).toContain('data-frame');
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toMatch(/正在读取|加载中/);
});

it('shows a failed read with a way to read again, never another workspace', () => {
  h.view.error = new Error('network');
  const html = renderToStaticMarkup(<RuntimePage />);
  expect(html).toContain('暂时无法读取这项工作');
  expect(html).toContain('重新读取');
});

it('tells an old conversation it is no longer shown, with a way to a new one, and opens no workspace', () => {
  for (const data of [{ scope: null }, { scope: { kind: 'something_else' } }, { legacy: true, scope: { kind: 'positioning_draft' } }, {}]) {
    h.view.data = data;
    const html = renderToStaticMarkup(<RuntimePage />);
    expect(html).toContain('这个对话是旧版本产生的，已不再支持查看');
    expect(html).toContain('开始新对话');
    expect(html).not.toMatch(/turn:|work:/);
  }
});

it('sends a link without a conversation to the start page', () => {
  h.session = '';
  expect(renderToStaticMarkup(<RuntimePage />)).toContain('aria-busy="true"');
});
