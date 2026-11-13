/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/trpc/client', () => ({ trpc: {} }));
import { MinutesButton, SessionMinutesPanel, type SessionMinutes } from './session-minutes';
import type { MinutesItem } from '@/lib/session-minutes';

const item = (n: number, over: Partial<MinutesItem> = {}): MinutesItem => ({ turnId: n,
  requestId: '00000000-0000-4000-8000-00000000000' + n, state: 'closed', closeKind: 'completed', failureCode: null, chargedCredits: 3,
  openedAt: '2026-11-14T01:00:00Z', closedAt: '2026-11-14T01:01:00Z',
  body: '## 讨论了什么\n- 第' + n + '份', available: true, ...over });
const minutes = (over: Partial<SessionMinutes> = {}): SessionMinutes => ({ items: [], running: false, live: '', notice: '', held: false,
  start: async () => undefined, error: null, retry: async () => undefined, ...over } as unknown as SessionMinutes);

// CONTENT-CONVERSATION-2: the newest minutes in full with copy and export, older ones folded, nothing at all before the first.
it('shows the newest minutes, folds the older ones, and nothing before the first minutes', () => {
  expect(renderToStaticMarkup(<SessionMinutesPanel minutes={minutes()} title="纪要" />)).toBe('');
  const items = [item(2), item(1), item(3, { available: false, body: null })];
  const html = renderToStaticMarkup(<SessionMinutesPanel minutes={minutes({ items })} title="纪要" />);
  expect(html).toContain('第2份');
  expect(html).toContain('复制');
  expect(html).toContain('导出 Markdown');
  expect(html).toContain('历史纪要（1）');
  expect(html).not.toContain('第3份');
});

it('shows what is being written while it runs, and a refusal in words', () => {
  const live = renderToStaticMarkup(<SessionMinutesPanel minutes={minutes({ running: true, live: '正在写的纪要' })} title="纪要" />);
  expect(live).toContain('正在写的纪要');
  const refused = renderToStaticMarkup(<SessionMinutesPanel minutes={minutes({ notice: '这段对话还没有内容，暂时不能整理。' })} title="纪要" />);
  expect(refused).toContain('还没有内容');
});

it('names the button by its page and by what it is doing', () => {
  expect(renderToStaticMarkup(<MinutesButton minutes={minutes()} label="整理本选题" />)).toContain('整理本选题');
  expect(renderToStaticMarkup(<MinutesButton minutes={minutes({ running: true })} label="整理纪要" />)).toContain('正在整理…');
  expect(renderToStaticMarkup(<MinutesButton minutes={minutes({ held: true })} label="整理纪要" />)).toContain('继续上次的整理');
});
