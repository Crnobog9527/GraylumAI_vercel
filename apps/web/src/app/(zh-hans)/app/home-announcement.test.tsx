/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ANNOUNCEMENT } from '@/lib/announcement';

const read = { isSuccess: true, isPending: false, error: null, refetch: vi.fn() };
vi.mock('@/trpc/client', () => ({ trpc: {
  user: { getUserProfile: { useQuery: () => ({ data: { nickname: 'Fixture', membership_level: 'free' }, isError: false }) } },
  opc: { library: { useQuery: () => ({ ...read, data: { businesses: [] } }) }, list: { useQuery: () => ({ ...read, data: { drafts: [] } }) } },
} }));
vi.mock('@/hooks/use-credits', () => ({ useCreditsBalance: () => ({ status: 'ready', credits: 100 }) }));
vi.mock('@/components/layout/LanguageSwitch', () => ({ LanguageSwitch: () => <button data-language-switch="" /> }));
import HomePage from './page';

const SRC = join(__dirname, '../../..');
const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
});

// Owner 2026-11-12 (controller 2026-11-13): the announcement of the signed-in pages hangs on the home page too.
it('shows the signed-in pages\' announcement under the home page\'s top bar, with the same message and button', () => {
  const html = renderToStaticMarkup(<HomePage />);
  expect(html.split('data-announcement=').length - 1).toBe(1);
  // Straight under the top bar and above the page, as on the other signed-in pages.
  expect(html).toMatch(new RegExp(`</header><div class="[^"]*announcement[^"]*" data-announcement="${ANNOUNCEMENT.id}">`));
  expect(html.indexOf('data-announcement=')).toBeLessThan(html.indexOf('<main'));
  expect(html).toContain(`<strong>${ANNOUNCEMENT.text}</strong>`);
  expect(html).toMatch(new RegExp(`<a href="${ANNOUNCEMENT.href.replace(/[/?]/g, '\\$&')}"[^>]*>${ANNOUNCEMENT.cta}<svg`));
  expect(html).toContain('aria-label="关闭公告"');
});

it('uses the one record of closing it, so closing it here closes it on the other signed-in pages and back', () => {
  const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
  expect(page).toContain("import { useAnnouncementOpen } from '@/components/opc/use-announcement';");
  expect(page).toContain('const [noticeOpen,closeNotice]=useAnnouncementOpen();');
  // No message of its own: the bar's default is the one in lib/announcement.ts.
  expect(page).toContain('{noticeOpen&&<AnnouncementBar onClose={closeNotice}/>}');
  // A closed one is hidden before the first paint by the same rule as elsewhere: the bar's class is the workbench's.
  const css = readFileSync(join(SRC, 'components/opc/workspace-frame.module.css'), 'utf8');
  expect(css).toContain(':global(html[data-announcement-closed]) .announcement{display:none}');
});

it('leaves the public pages without it', () => {
  const users = ['components/landing', 'components/public-site', 'components/layout'].flatMap(dir => sources(join(SRC, dir)))
    .filter(path => /AnnouncementBar|use-announcement/.test(readFileSync(path, 'utf8')));
  expect(users).toEqual([]);
});
