/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ open: false as boolean | undefined, compare: true, jury: true, area: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { features: { useQuery: () => ({ data: state.open === undefined ? undefined : { ownData: state.open } }) } } } }));
vi.mock('@/components/opc/workspace-frame', () => ({
  WorkspaceFrame: ({ area, children }: { area: string; children: ReactNode }) => { state.area = area; return <div data-frame={area}>{children}</div>; },
}));
vi.mock('@/components/opc/rail-gold-tools', () => ({
  useRailGoldTools: () => ({ onCompare: state.compare ? () => {} : undefined, onJury: state.jury ? () => {} : undefined, dialogs: <span data-dialogs="" /> }),
}));
import ToolsPage from './page';

beforeEach(() => { state.open = false; state.compare = true; state.jury = true; });
const tiles = (html: string) => [...html.matchAll(/<li>(<a [^>]*href="([^"]+)"|<button type="button"|<div aria-disabled="true")[^>]*>.*?<b>([^<]+)(<small>([^<]+)<\/small>)?<\/b>/g)]
  .map(tile => [tile[3], tile[2] ?? (tile[1].startsWith('<button') ? 'button' : 'waiting'), tile[5] ?? '']);

// Owner 2026-11-12, phone plan A: the 功能 page lists what the rail's function links lead to; nothing in it is new.
it('lists the rail\'s own entries; 发布排期 and 数据复盘 wait until their switch is on, 集成 waits for its page', () => {
  const html = renderToStaticMarkup(<ToolsPage />);
  expect(state.area).toBe('tools');
  expect(tiles(html)).toEqual([
    ['功能广场', '/app/workbench/marketplace', ''], ['资料库', '/app/library', ''], ['发布排期', 'waiting', '待接入'], ['数据复盘', 'waiting', '待接入'],
    ['多模型对比', 'button', ''], ['评审团', 'button', ''], ['集成', 'waiting', '待接入'],
  ]);
  expect(html).toMatch(/<h1>功能<\/h1><a [^>]*href="\/app\/workbench\/search"/);
  expect(html).toMatch(/<a [^>]*href="\/app\/profile\?tab=tickets"[^>]*>.*?在线反馈/);
  expect(html).toContain('data-dialogs');
  // 集成 is kept a place for, never a link to a page that is not there.
  expect(html).not.toContain('/app/integrations');
});

it('once the publishing switch is on, 发布排期 and 数据复盘 are links, as in the rail', () => {
  state.open = true;
  const listed = tiles(renderToStaticMarkup(<ToolsPage />));
  expect(listed).toContainEqual(['发布排期', '/app/publish-schedule', '']);
  expect(listed).toContainEqual(['数据复盘', '/app/publish-monitor', '']);
});

it('while the switch\'s answer is unknown they wait: nothing is offered by guess', () => {
  state.open = undefined;
  expect(tiles(renderToStaticMarkup(<ToolsPage />)).filter(tile => tile[1] === 'waiting').map(tile => tile[0])).toEqual(['发布排期', '数据复盘', '集成']);
});

it('shows 多模型对比 and 评审团 only when the rail would (the same hook decides), each a button', () => {
  state.compare = false; state.jury = false;
  const names = tiles(renderToStaticMarkup(<ToolsPage />)).map(tile => tile[0]);
  expect(names).not.toContain('多模型对比');expect(names).not.toContain('评审团');
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
  expect(page).toContain('useRailGoldTools({ navigate: href => router.push(href) })');
});

it('the 对话 page is the shell\'s list on a phone and sends a computer on to the new-conversation page', () => {
  const page = readFileSync(fileURLToPath(new URL('../chats/page.tsx', import.meta.url)), 'utf8');
  expect(page).toContain('<WorkspaceFrame area="history">');
  expect(page).toContain("if (!window.matchMedia('(max-width: 639px)').matches) router.replace('/app/positioning');");
});
