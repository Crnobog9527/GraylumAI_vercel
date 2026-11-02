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
import RuntimePage from './page';

beforeEach(() => { h.session = 's1'; h.view = { data: undefined, error: undefined, refetch: () => Promise.resolve() }; });

it('opens a free conversation and a work item in the turn workspaces once the scope is read', () => {
  h.view.data = { scope: { kind: 'positioning_draft' } };
  expect(renderToStaticMarkup(<RuntimePage />)).toContain('turn:s1');
  h.view.data = { scope: { kind: 'work_item', workItemId: 'w1' } };
  expect(renderToStaticMarkup(<RuntimePage />)).toContain('work:w1');
});

it('renders no workspace before the scope has been read', () => {
  expect(renderToStaticMarkup(<RuntimePage />)).toBe('<p>正在读取工作…</p>');
});

it('shows a failed read with a way to read again, never another workspace', () => {
  h.view.error = new Error('network');
  const html = renderToStaticMarkup(<RuntimePage />);
  expect(html).toContain('暂时无法读取这项工作');
  expect(html).toContain('重新读取');
});

it('sends a link without a conversation to the start page', () => {
  h.session = '';
  expect(renderToStaticMarkup(<RuntimePage />)).toBe('<p>正在进入新任务…</p>');
});
