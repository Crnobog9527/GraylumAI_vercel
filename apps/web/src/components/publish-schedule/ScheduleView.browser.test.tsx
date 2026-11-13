/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The real "发布排期" calendar inside the workbench's center panel (its real CSS), against simulated tRPC answers; no request
// leaves the browser. What only a rendered page shows: the month fills the panel and its chips open the post, the week axis
// scrolls inside the panel to the first post, the switch and paging work, and a phone gets a list that does not widen it.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__schedule_fixture__.js', import.meta.url));
const file = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
const SHOTS = process.env.SCHEDULE_SHOTS;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    css: { postcss: { plugins: [] } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'schedule-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link') return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const useSearchParams=()=>new URLSearchParams(location.search); export const usePathname=()=>'/app/publish-schedule';`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:null},error:null}),
          onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpBatchLink} from '@trpc/client'; import {trpc} from ${file('../../trpc/client.ts')};
          import frame from ${file('../opc/workspace-frame.module.css')};
          import {ScheduleView} from ${file('./ScheduleView.tsx')};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpBatchLink({url:'http://schedule.test/api/trpc'})]});
          const h=React.createElement;
          createRoot(document.getElementById('root')).render(h(trpc.Provider,{client,queryClient},
            h(QueryClientProvider,{client:queryClient},h('div',{className:frame.workspace},
              h('div',{className:frame.shell+' '+frame.noNotice},h('aside',{className:frame.rail}),
                h('section',{className:frame.center},h(ScheduleView)))))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ScheduleTest', formats: ['iife'] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; fileName: string;
    code?: string; source?: string | Uint8Array }>;
  code = output.find(item => item.type === 'chunk')!.code!;
  css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

/** Posts around a fixed Wednesday, 18 November 2026, in the page's own time zone (the browser's clock is set to it). */
const local = (day: number, hour: number, minute = 0) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:`
  + `${String(minute).padStart(2, '0')}:00-08:00`;
const job = (id: string, at: string, state: string, platforms: string[], extra: Record<string, unknown> = {}) => ({ id, state, at,
  scheduledAt: at, captionPreview: `示例文案 ${id}`, cancelReason: null, errorCode: null, manualReview: false, holdCredits: 12,
  chargedCredits: state === 'completed' ? 6 : null, ...extra,
  targets: platforms.map((platform, index) => ({ connectionId: `${id}-${index}`, platform,
    status: state === 'completed' ? 'published' : state === 'failed' ? 'failed' : 'pending',
    url: state === 'completed' ? `https://example.com/${id}` : null })) });
const POSTS = [
  job('a', local(18, 15), 'scheduled', ['xiaohongshu', 'douyin']),
  job('b', local(18, 15, 20), 'scheduled', ['instagram']),
  job('c', local(16, 9), 'completed', ['xiaohongshu']),
  job('d', local(17, 20, 30), 'failed', ['douyin']),
  job('e', local(19, 12), 'released', ['tiktok'], { cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' }),
  job('f', local(20, 18), 'dispatching', ['youtube']),
  ...[8, 10, 12, 14].map(hour => job(`g${hour}`, local(25, hour), 'scheduled', ['xiaohongshu'])),
];

async function open(width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
  // Wednesday 18 November 2026, 10:00 local: 15:00 is still more than 10 minutes away, so post "a" can be moved.
  await context.addInitScript(`{ const fixed = ${Date.parse('2026-11-18T10:00:00-08:00')}; const Real = Date;
    globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }; }`);
  const page = await context.newPage();
  const errors: string[] = [];
  const ranges: Array<{ from: string; to: string }> = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><div id="root"></div></body>' });
    const paths = url.pathname.replace('/api/trpc/', '').split(',');
    const input = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<string, { json?: unknown } | unknown>;
    const body = paths.map((path, index) => {
      if (path === 'publishMonitor.schedule.list') {
        const range = (input[String(index)] ?? {}) as { from: string; to: string };
        ranges.push(range);
        return { result: { data: POSTS.filter(post => post.at && Date.parse(post.at) >= Date.parse(range.from)
          && Date.parse(post.at) < Date.parse(range.to)) } };
      }
      if (path === 'opc.list') return { result: { data: { drafts: [{ draftId: 'd1', state: 'published' }] } } };
      return { result: { data: [] } };
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://schedule.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('heading', { name: '2026年11月' })).toBeVisible({ timeout: 10000 });
  return { page, errors, ranges, close: () => context.close() };
}

it('the month fills the panel; a chip opens the post, and 改期 opens the reschedule dialog', async () => {
  const { page, errors, ranges, close } = await open(1440, 900);
  try {
    expect(ranges[0]).toEqual({ from: '2026-10-26T07:00:00.000Z', to: '2026-12-07T08:00:00.000Z' });
    await ui(page.getByRole('button', { name: '15:00 小红书、抖音，已排期，示例文案 a' })).toBeVisible();
    await ui(page.getByRole('button', { name: /20:30 抖音，失败/ })).toBeVisible();
    await ui(page.getByText('还有 2 条')).toBeVisible();
    // Six weeks fill the panel's height: the last row ends near the panel's bottom, not halfway up.
    const gap = await page.evaluate(() => {
      const rows = document.querySelectorAll('[role="row"]');
      const panel = document.querySelector('main')!.getBoundingClientRect();
      return panel.bottom - rows[rows.length - 1]!.getBoundingClientRect().bottom;
    });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/month.png` });
    expect(Math.abs(gap)).toBeLessThan(40);
    await page.getByRole('button', { name: /15:00 小红书、抖音/ }).click();
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('冻结 12 积分', { exact: false })).toBeVisible();
    await ui(dialog.getByText('小红书')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/detail.png` });
    // The corner icon is named in Chinese too (screen readers said "Close"; validation of #1928): it and the footer button.
    await ui(dialog.getByRole('button', { name: '关闭', exact: true })).toHaveCount(2);
    await dialog.getByRole('button', { name: '改期' }).click();
    await ui(page.getByRole('dialog').getByLabel('新的发布时间')).toBeVisible();
    // The footer's 关闭 comes before the corner icon.
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click();
    // The sent post says so in words and links to itself.
    await page.getByRole('button', { name: /09:00 小红书，已发布/ }).click();
    await ui(page.getByRole('dialog').getByText('小红书 · 已发布')).toBeVisible();
    await ui(page.getByRole('dialog').getByRole('link', { name: '查看帖子' })).toHaveAttribute('href', 'https://example.com/c');
    expect(errors).toEqual([]);
  } finally { await close(); }
}, 45000);

it('"还有 2 条" opens that week on the time axis, scrolled inside the panel; posts close together share the width', async () => {
  const { page, errors, ranges, close } = await open(1440, 900);
  try {
    await page.getByRole('button', { name: /11月25日 周三还有 2 条/ }).click();
    await ui(page.getByRole('heading', { name: '2026年11月23日 – 29日' })).toBeVisible();
    await expect.poll(() => ranges.at(-1)).toEqual({ from: '2026-11-23T08:00:00.000Z', to: '2026-11-30T08:00:00.000Z' });
    await ui(page.getByRole('button', { name: /14:00 小红书/ })).toBeVisible();
    // Back to this week: the two posts at 15:00 and 15:20 stand side by side.
    await page.getByRole('button', { name: '上一周' }).click();
    await ui(page.getByRole('heading', { name: '2026年11月16日 – 22日' })).toBeVisible();
    const [a, b] = await Promise.all(['15:00 小红书、抖音', '15:20 Instagram'].map(name =>
      page.getByRole('button', { name: new RegExp(name) }).boundingBox()));
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + 1);
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(25);
    // Side by side (58px each at 1440px) a card reads its time on a line of its own, nothing cut after it; its platforms below.
    // Before (validation of #1928) the first line was "15:00 · 已排期" and showed as "15:00…".
    for (const name of ['15:00 小红书、抖音', '15:20 Instagram']) {
      const first = await page.getByRole('button', { name: new RegExp(name) }).evaluate(card => {
        const line = card.firstElementChild as HTMLElement;
        return { text: line.textContent, cut: line.scrollWidth > line.clientWidth + 1 };
      });
      expect(first).toEqual({ text: name.slice(0, 5), cut: false });
    }
    // The week opens at 8:00 (the earliest post is 9:00): its 9:00 card is in view inside the panel.
    const card = await page.getByRole('button', { name: /09:00 小红书/ }).boundingBox();
    expect(card!.y).toBeGreaterThan(100);
    expect(card!.y).toBeLessThan(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/week.png` });
    await page.getByRole('button', { name: '月', exact: true }).click();
    await ui(page.getByRole('heading', { name: '2026年11月' })).toBeVisible();
    await ui(page.getByRole('button', { name: '今天', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '下一月' }).click();
    await ui(page.getByRole('heading', { name: '2026年12月' })).toBeVisible();
    await page.getByRole('button', { name: '今天', exact: true }).click();
    await ui(page.getByRole('heading', { name: '2026年11月' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await close(); }
}, 45000);

it('a 375px phone shows the whole month as a grid, today picked; another day lists its posts below and opens them', async () => {
  const { page, errors, close } = await open(375, 812);
  try {
    const grid = page.getByRole('group', { name: /2026年11月，选一天/ });
    // 1 to 30 November, each a button; no day of October or December, no week switch on a phone.
    await ui(grid.getByRole('button')).toHaveCount(30);
    await ui(page.getByRole('group', { name: '视图' })).toHaveCount(0);
    await ui(grid.getByRole('button', { name: '11月18日 周三（今天），2 条' })).toHaveAttribute('aria-pressed', 'true');
    await ui(page.getByRole('heading', { name: /11月18日 周三/ })).toBeVisible();
    await ui(page.getByRole('button', { name: /15:00 小红书、抖音，已排期/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone.png` });
    // The 25th has four posts: four cards below, the 18th's cards are gone.
    await grid.getByRole('button', { name: '11月25日 周三，4 条' }).click();
    await ui(page.getByRole('button', { name: /小红书，已排期/ })).toHaveCount(4);
    await ui(page.getByRole('button', { name: /15:00 小红书、抖音/ })).toHaveCount(0);
    await grid.getByRole('button', { name: '11月21日 周六，没有安排' }).click();
    await ui(page.getByText('这天没有安排。')).toBeVisible();
    // 今天 brings the pick back; a card opens the post with its actions.
    await page.getByRole('button', { name: '今天', exact: true }).click();
    await page.getByRole('button', { name: /15:00 小红书、抖音/ }).click();
    await ui(page.getByRole('dialog').getByRole('button', { name: '取消排期' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click();
    // Paging to December lands on the 1st.
    await page.getByRole('button', { name: '下一月' }).click();
    await ui(page.getByRole('group', { name: /2026年12月，选一天/ }).getByRole('button', { name: /12月1日 周二/ }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  } finally { await close(); }
}, 45000);
