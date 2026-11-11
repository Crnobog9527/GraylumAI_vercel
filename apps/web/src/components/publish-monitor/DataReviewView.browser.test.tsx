/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The real "数据复盘" page inside the workbench's center panel (its real CSS), against simulated tRPC answers; no request
// leaves the browser. Three things only a rendered page can show (found 2026-11-11): the page could not be scrolled past
// its first screen (the center panel clips, and the page did not scroll by itself), "1,400" on an axis was drawn as
// "400", and nothing may widen a 360px screen.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__data_review_fixture__.js', import.meta.url));
const file = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

const week = (index: number) => {
  const end = new Date(Date.UTC(2026, 7, 25 + 7 * index));
  return { start: new Date(end.getTime() - 6 * 86_400_000).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    posts: 4 + (index % 3), viewsMedian: 12_000 + index * 950, viewsSamples: 4, engagementMedian: 0.04 + index * 0.001,
    followers: 480 + index * 84, note: null };
};
const series = (connectionId: string, platform: string) => ({ connectionId, platform, businessName: '测试品牌',
  connectedOn: '2026-08-01', weeks: Array.from({ length: 12 }, (_, index) => week(index)), gaps: {} });
const ANSWERS: Record<string, unknown> = {
  'opc.library': { businesses: [] },
  'publishMonitor.connections': [],
  'publishMonitor.data': { windowDays: 90, connections: [{ id: 'c1', platform: 'douyin' }], posts: [0, 1, 2].map(index => ({
    id: `p${index}`, connectionId: 'c1', source: 'tikhub', url: `https://example.com/p/${index}`, postedAt: '2026-11-03T08:00:00Z',
    postedAtSource: 'provider', firstSeenAt: '2026-11-04T00:00:00Z', workItemId: null,
    titleExcerpt: '一个很长很长的作品标题用来确认它在手机上会换行而不是把页面撑宽'.repeat(index + 1),
    latest: { capturedOn: '2026-11-10', missingFields: ['shares'],
      metrics: { views: 12_000 + index, impressions: 90_000, reach: 40_000, likes: 300, comments: 20, saves: 15, followers_gained: 4 } } })) },
  'publishMonitor.trend': { windowDays: 90, series: [series('c1', 'douyin'), series('c2', 'youtube')] },
  'publishMonitor.features': { ownData: true, weeklyReview: true, publish: false },
  'publishMonitor.review.list': [{ id: 'r1', periodStart: '2026-11-03T00:00:00Z', status: 'completed', body: '这一周的复盘正文。',
    tables: null, notice: null, cadence: 'weekly', businessName: '测试品牌' }],
  'publishMonitor.review.pillars': [{ businessId: 'b1', businessName: '测试品牌', source: 'user',
    pillars: [{ key: 'k1', name: '读书笔记' }, { key: 'k2', name: '城市探店' }] }],
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    // Only the CSS modules are needed; the app's PostCSS setup (Tailwind) is not loaded.
    css: { postcss: { plugins: [] } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'data-review-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link') return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const useSearchParams=()=>new URLSearchParams(location.search);`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:null},error:null}),
          onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpBatchLink} from '@trpc/client'; import {trpc} from ${file('../../trpc/client.ts')};
          import frame from ${file('../opc/workspace-frame.module.css')};
          import {DataReviewView} from ${file('./DataReviewView.tsx')};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpBatchLink({url:'http://review.test/api/trpc'})]});
          const h=React.createElement;
          createRoot(document.getElementById('root')).render(h(trpc.Provider,{client,queryClient},
            h(QueryClientProvider,{client:queryClient},h('div',{className:frame.workspace},
              h('div',{className:frame.shell+' '+frame.noNotice},h('aside',{className:frame.rail}),
                h('section',{className:frame.center},h(DataReviewView)))))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'DataReviewTest', formats: ['iife'] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; fileName: string;
    code?: string; source?: string | Uint8Array }>;
  code = output.find(item => item.type === 'chunk')!.code!;
  css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  // Playwright's own headless Chromium, on a developer machine as in CI: it starts and closes in well under a second.
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

/** The tick texts of every vertical axis (recharts 3 draws them in their own layer, beside the axis group). */
const Y_TICKS = '.recharts-yAxis-tick-labels text';

type Sent = { paths: string[]; at: number };
async function open(width: number, height: number, reducedMotion: 'reduce' | 'no-preference' = 'no-preference', firstReadsTakeMs = 0) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  const errors: string[] = [];
  // Every tRPC request in the order it left the page, and when the page's first reads were answered.
  const sent: Sent[] = [];
  const answered: { firstReads: number | null } = { firstReads: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><div id="root"></div></body>' });
    const paths = url.pathname.replace('/api/trpc/', '').split(',');
    sent.push({ paths, at: Date.now() });
    const first = paths.includes('publishMonitor.data');
    if (first && firstReadsTakeMs) await new Promise(resolve => setTimeout(resolve, firstReadsTakeMs));
    // Batched like the app: one answer per read, in the order asked.
    const body = paths.map(path => ({ result: { data: ANSWERS[path] ?? {} } }));
    if (first) answered.firstReads = Date.now();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://review.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('tab', { name: '数据趋势' })).toBeVisible({ timeout: 10000 });
  await ui(page.locator(Y_TICKS).first()).toBeVisible({ timeout: 10000 });
  return { page, errors, sent, answered };
}

const top = (page: Page) => page.locator('figure').last().evaluate(node => Math.round(node.getBoundingClientRect().top));
const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

it('scrolls past the first screen inside the workbench panel, and no axis number is cut on the left', async () => {
  const { page, errors } = await open(1280, 720);
  try {
    // The fourth chart starts below the fold of a 720px window; the wheel must bring it up.
    const before = await top(page);
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => top(page), { timeout: 3000 }).toBeLessThan(before - 200);

    // Every tick of every vertical axis lies inside its chart, and a four-digit tick keeps all its digits.
    const ticks = await page.locator(Y_TICKS).evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent ?? '', left: node.getBoundingClientRect().left,
      chartLeft: node.closest('svg')!.getBoundingClientRect().left })));
    expect(ticks.length).toBeGreaterThan(8);
    for (const tick of ticks) expect(tick.left, `axis tick ${tick.text}`).toBeGreaterThanOrEqual(tick.chartLeft);
    expect(ticks.some(tick => /^\d,\d{3}$/.test(tick.text))).toBe(true);
    expect(ticks.some(tick => tick.text.endsWith('万'))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('fits a 360px screen: the tab bar and the account switch scroll sideways inside the page, the page itself does not', async () => {
  const { page, errors } = await open(360, 780, 'reduce');
  try {
    expect(await pageWidth(page)).toBe(360);
    // The last tab is reachable by scrolling the bar, and choosing another account does not widen the page either.
    await page.getByRole('tab', { name: '表格导入' }).click();
    await ui(page.getByRole('tab', { name: '表格导入' })).toHaveAttribute('data-state', 'active');
    await page.getByRole('tab', { name: '数据趋势' }).click();
    await page.getByRole('button', { name: '测试品牌 · YouTube' }).click();
    await ui(page.getByRole('button', { name: '测试品牌 · YouTube' })).toHaveAttribute('aria-pressed', 'true');
    await ui(page.locator('figure')).toHaveCount(4);
    expect(await pageWidth(page)).toBe(360);
    // With reduced motion nothing is left mid-animation: the cards are fully shown at once.
    const opacity = await page.locator('figure').first().evaluate(node => getComputedStyle(node).opacity);
    expect(opacity).toBe('1');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('asks for the trend data with the first reads, in a request of its own, not after they are answered', async () => {
  // 2026-11-11 (PERF): the trend read left only after the first reads came back, one round trip late. Here the first
  // reads take 600 ms to answer; the trend read must already have left by then, and must not sit in their request.
  const { page, sent, answered, errors } = await open(1280, 720, 'reduce', 600);
  try {
    const trend = sent.filter(request => request.paths.includes('publishMonitor.trend'));
    expect(trend).toHaveLength(1);
    expect(trend[0]!.paths).toEqual(['publishMonitor.trend']);
    // The first reads did travel together, so "a request of its own" above is not an accident of the test setup.
    expect(sent.find(request => request.paths.includes('publishMonitor.data'))!.paths).toContain('publishMonitor.connections');
    expect(answered.firstReads).not.toBeNull();
    expect(trend[0]!.at).toBeLessThan(answered.firstReads!);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('posts read as a table on a desktop and as cards on a phone, from the same list, without a sideways scroll on the phone', async () => {
  const wide = await open(1280, 720, 'reduce');
  try {
    await wide.page.getByRole('tab', { name: '作品数据' }).click();
    const label = wide.page.locator('dl dt').first();
    await ui(wide.page.getByText('发布日期', { exact: true })).toBeVisible();
    await ui(label).toBeHidden();
    expect(wide.errors).toEqual([]);
  } finally { await wide.page.close(); }
  const phone = await open(360, 780, 'reduce');
  try {
    await phone.page.getByRole('tab', { name: '作品数据' }).click();
    // Eight numbers per post: on a phone each sits under its own label, and the column header row is gone.
    await ui(phone.page.locator('dl dt').first()).toBeVisible();
    await ui(phone.page.getByText('发布日期', { exact: true })).toBeHidden();
    await ui(phone.page.getByText('平台不提供').first()).toBeVisible();
    expect(await pageWidth(phone.page)).toBe(360);
    const widest = await phone.page.locator('main li').evaluateAll(nodes => Math.max(...nodes.map(node => node.getBoundingClientRect().right)));
    expect(widest).toBeLessThanOrEqual(360);
    expect(phone.errors).toEqual([]);
  } finally { await phone.page.close(); }
}, 45000);

it('weekly reviews: the settings sit beside the reading on a wide screen and fold away above it on a narrower one', async () => {
  const wide = await open(1600, 800, 'reduce');
  try {
    await wide.page.getByRole('tab', { name: '每周复盘' }).click();
    await ui(wide.page.getByText('这一周的复盘正文。')).toBeVisible();
    // Wide: the pillars are there without a click, to the right of the review.
    const pillar = wide.page.getByLabel('内容方向 1 名称');
    await ui(pillar).toBeVisible();
    await ui(wide.page.getByRole('button', { name: '复盘设置' })).toBeHidden();
    const [reviewBox, pillarBox] = [await wide.page.getByText('这一周的复盘正文。').boundingBox(), await pillar.boundingBox()];
    expect(pillarBox!.x).toBeGreaterThan(reviewBox!.x + reviewBox!.width);
  } finally { await wide.page.close(); }
  for (const [width, height] of [[1280, 720], [360, 780]] as const) {
    const narrow = await open(width, height, 'reduce');
    try {
      await narrow.page.getByRole('tab', { name: '每周复盘' }).click();
      await ui(narrow.page.getByText('这一周的复盘正文。')).toBeVisible();
      const fold = narrow.page.getByRole('button', { name: '复盘设置' });
      await ui(fold).toHaveAttribute('aria-expanded', 'false');
      await ui(narrow.page.getByLabel('内容方向 1 名称')).toBeHidden();
      await fold.click();
      await ui(narrow.page.getByLabel('内容方向 1 名称')).toBeVisible();
      expect(await pageWidth(narrow.page)).toBe(width);
      expect(narrow.errors).toEqual([]);
    } finally { await narrow.page.close(); }
  }
}, 60000);
