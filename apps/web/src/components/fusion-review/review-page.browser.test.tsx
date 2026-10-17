/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The real review page against fusionReview answers shaped like the API's (FUSION-REVIEW PR-5). No model is called.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__review_page_fixture__.js', import.meta.url));
const DRAFT = '30000000-0000-4000-8000-000000000001';
const REVIEW = '30000000-0000-4000-8000-000000000002';
/** Seat names as an administrator sets them; the page must show these, never fixed ones. */
const PANEL = { reviewers: [{ seat: 'A', name: '目标用户' }, { seat: 'B', name: '操盘手' }, { seat: 'C', name: '挑刺审核人' }],
  summary: { seat: 'S', name: '主笔' } };
const ruling = (section: string, opinion: string, adopted: boolean) => ({ section, issue: '问题', reviewers: ['A', 'C'], single: false,
  disputed: false, opinion, reason: '理由足够长，写清楚为什么要这样改。', fix: '改法', adopted });
/** Chapter titles as long as a real report's: the contents column must not grow over the reading column. */
const LONG = '二、你真正想要的结果，以及这条路能不能走通（约 500 字）';
const detail = (state: string, draftId = DRAFT, long = false) => ({
  reviewId: REVIEW, draftId, state, outcome: state === 'completed' ? { kind: 'revised' } : null,
  seats: ['A', 'B', 'C'].map(seat => ({ seat, rounds: [{ round: 1, status: state === 'running' ? 'pending' : 'usable', decisions: [], issues: [] }] })),
  summary: state === 'running' ? { status: 'none', sections: [] } : { status: 'usable', sections: [
    { section: long ? LONG : '定位', changed: true, wordingOnly: false, original: '给所有上班族的家常菜。', revised: '给刚独居的上班族的十五分钟家常菜。',
      fields: [], linkedSections: [], rulings: [ruling(long ? LONG : '定位', '定位要写清人群', true)] },
    { section: '全文', changed: false, wordingOnly: false, fields: [], linkedSections: [], rulings: [ruling('全文', '全文语气要统一', false)] },
  ] },
  adoption: null, awaitingChoice: state === 'completed',
  chapters: [{ section: long ? LONG : '定位', body: '给所有上班族的家常菜。' }, { section: '结语', body: '先把承诺做扎实。' }],
});
const events = (state: string) => ({ ended: false, events: [
  { id: 'review_started', type: 'review_started', reviewers: ['A', 'B', 'C'], sections: 2 },
  ...(state === 'running' ? [] : [{ id: 'review_ended', type: 'review_ended', state, outcome: { kind: 'revised' } }]),
] });

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const pageFile = fileURLToPath(new URL('./ReviewPage.tsx', import.meta.url));
  const entryFile = fileURLToPath(new URL('./JuryEntry.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'review-page-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id === 'next/navigation' || id === 'next/link') return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:p=>{window.__pushed=p}});`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import {ReviewPage} from ${JSON.stringify(pageFile)}; import {JuryEntry} from ${JSON.stringify(entryFile)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://localhost/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},
              location.hash==='#entry'
                ? React.createElement('div',null,React.createElement(JuryEntry,{draftId:${JSON.stringify(DRAFT)},report:{available:true,id:${JSON.stringify(REVIEW)}},busy:false}),
                  React.createElement('p',null,'定位页脚'))
                : React.createElement(ReviewPage,{draftId:${JSON.stringify(DRAFT)},reviewId:${JSON.stringify(REVIEW)}}))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReviewPageTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  // The page's own stylesheets, so layout checks (overlap, sideways scrolling) run on the real layout.
  css = output.filter((item: { type: string; fileName: string }) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item: { source: string | Uint8Array }) => String(item.source)).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(state: string, opts: { draftId?: string; width?: number; long?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: opts.width ?? 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const calls: Record<string, number> = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const name = path.split('/').pop() ?? '';
    calls[name] = (calls[name] ?? 0) + 1;
    // A slow server: a double click must still send one request.
    if (name === 'fusionReview.adopt' || name === 'fusionReview.confirmAdoption') await new Promise(done => setTimeout(done, 300));
    const result = name === 'fusionReview.detail' ? detail(state, opts.draftId, opts.long) : name === 'fusionReview.events' ? events(state)
      : name === 'fusionReview.panel' ? PANEL : name === 'opc.list' ? { drafts: [{ draftId: DRAFT, businessName: '小林做饭' }] }
        : name === 'fusionReview.adopt' ? { state: 'proposed', revisionId: 'rev', diffHash: 'a'.repeat(64), adopted: ['定位'], kept: [],
          diff: { changes: [{ stepId: 's', stepTitle: '定位', fieldId: 'f', fieldTitle: '一句话定位', before: { value: '旧', status: 'confirmed' },
            after: { value: '新', status: 'confirmed' } }], cascade: [] } }
          : name === 'fusionReview.confirmAdoption' ? (JSON.parse(route.request().postData() ?? '{}').decision === 'decline'
            ? { state: 'recorded', versionId: null, adopted: [], kept: ['定位'] }
            : { state: 'recorded', versionId: 'v2', adopted: ['定位'], kept: [] })
            : name === 'fusionReview.continue' ? { review: {}, calls: [], background: true } : { seen: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
  });
  // localhost is a secure context, as the real https site is (crypto.randomUUID).
  await page.goto('http://localhost/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  return { page, errors, calls };
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

it('shows an ended review as the whole report with the 全文 card, and submits each step once', async () => {
  const { page, errors, calls } = await open('completed');
  try {
    await ui(page.getByRole('heading', { name: '评审团的结果' })).toBeVisible({ timeout: 8000 });
    await ui(page.getByText('返回：我的定位分析 · 小林做饭')).toBeVisible();
    await ui(page.locator('[id="chapter-全文"]')).toBeVisible();
    await ui(page.getByText('全文语气要统一').first()).toBeVisible();
    await page.getByRole('radio', { name: '看全文' }).click();
    await ui(page.getByText('先把承诺做扎实。').first()).toBeVisible();
    await page.getByText('采用修订版').first().click();
    await page.getByRole('button', { name: '确认', exact: true }).dblclick();
    await ui(page.getByText('确认前先看一眼')).toBeVisible({ timeout: 5000 });
    expect(calls['fusionReview.adopt']).toBe(1);
    await page.getByRole('button', { name: '确认采用，生成新版本' }).dblclick();
    await ui(page.getByText('新版本已生成')).toBeVisible({ timeout: 5000 });
    expect(calls['fusionReview.confirmAdoption']).toBe(1);
    expect(calls['fusionReview.markSeen']).toBeGreaterThanOrEqual(1);
    expect(calls['fusionReview.continue'] ?? 0).toBe(0); // an ended review is never handed on
    expect(await noSideScroll(page)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('plays a running review with the administrator\'s seat names, hands it to the server, and lets the user leave', async () => {
  const { page, errors, calls } = await open('running');
  try {
    await ui(page.getByRole('heading', { name: '评审团正在审阅你的定位报告' })).toBeVisible({ timeout: 8000 });
    await ui(page.getByText(/评审在后台进行/)).toBeVisible();
    await ui(page.getByText('挑刺审核人').first()).toBeVisible();
    await ui(page.getByRole('button', { name: '停止评审' })).toBeVisible();
    expect(calls['fusionReview.continue']).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: '先去忙别的' }).click();
    expect(await page.evaluate(() => (window as unknown as { __pushed?: string }).__pushed)).toBe(`/positioning/${DRAFT}`);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('keeps 看全文 clickable at computer width when chapter titles are long (staging 2026-10-17)', async () => {
  const { page, errors } = await open('completed', { long: true });
  try {
    await ui(page.getByRole('heading', { name: '评审团的结果' })).toBeVisible({ timeout: 8000 });
    // The contents stay inside their column: nothing of them lies over the reading column.
    const overlap = await page.evaluate(() => {
      const toc = document.querySelector('nav[aria-label="报告目录"]')!;
      const column = document.getElementById('jury-reader-chapters')!.getBoundingClientRect().left;
      return [toc, ...toc.querySelectorAll('*')].some(node => node.getBoundingClientRect().right > column);
    });
    expect(overlap).toBe(false);
    await page.getByRole('radio', { name: '看全文' }).click({ timeout: 3000 });
    await ui(page.getByText('先把承诺做扎实。').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('works at phone width without sideways scrolling', async () => {
  const { page, errors } = await open('completed', { width: 390 });
  try {
    await ui(page.getByRole('heading', { name: '评审团的结果' })).toBeVisible({ timeout: 8000 });
    expect(await noSideScroll(page)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('does not show a review that belongs to another analysis', async () => {
  const { page, errors } = await open('completed', { draftId: '30000000-0000-4000-8000-000000000009' });
  try {
    await ui(page.getByText('找不到这次评审。')).toBeVisible({ timeout: 8000 });
    await ui(page.getByText('定位要写清人群')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

/** The positioning page's entry, on its own: the switch, the newest review of this analysis, and start. */
async function openEntry(answers: { enabled: boolean; mine?: unknown[]; refuse?: string }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const starts: unknown[] = [];
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const calls: Record<string, number> = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const name = path.split('/').pop() ?? '';
    calls[name] = (calls[name] ?? 0) + 1;
    if (name === 'fusionReview.start') {
      starts.push(JSON.parse(route.request().postData() ?? '{}'));
      await new Promise(done => setTimeout(done, 300));
    }
    if (name === 'fusionReview.start' && answers.refuse) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: answers.refuse,
        code: -32603, data: { code: 'FORBIDDEN', httpStatus: 403, path: 'fusionReview.start' } } }) });
    }
    const result = name === 'fusionReview.available' ? { enabled: answers.enabled } : name === 'fusionReview.mine' ? answers.mine ?? []
      : name === 'fusionReview.panel' ? PANEL : name === 'fusionReview.start' ? { reviewId: REVIEW, state: 'running' }
        : name === 'fusionReview.estimate' ? { estimateCredits: 1280, maxRounds: 2, reviewers: 3 } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
  });
  await page.goto('http://localhost/#entry');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByText('定位页脚')).toBeVisible({ timeout: 8000 });
  await page.waitForLoadState('networkidle');
  return { page, errors, calls, starts };
}
const mineItem = (state: string, awaitingChoice = false) => ({ reviewId: REVIEW, draftId: DRAFT, sourceVersionId: REVIEW, state, round: 1,
  phase: 'review', outcomeKind: null, awaitingChoice, createdAt: '2026-10-16T00:00:00.000000+00:00', endedAt: null, seenAt: null });

it('shows no entry and no error when the jury is switched off', async () => {
  const { page, errors, calls } = await openEntry({ enabled: false });
  try {
    expect(await page.getByText(/评审团/).count()).toBe(0);
    expect(calls['fusionReview.mine'] ?? 0).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('starts one review with the panel\'s names and opens its page; a running one is linked instead', async () => {
  const { page, errors, calls, starts } = await openEntry({ enabled: true });
  try {
    expect(calls['fusionReview.estimate'] ?? 0).toBe(0); // nothing is estimated until the user opens the card
    await page.getByRole('button', { name: '请评审团审阅报告' }).click();
    await ui(page.getByText(/3 位评审（目标用户、操盘手、挑刺审核人）/)).toBeVisible();
    // The maximum is shown before the user agrees, and start carries exactly that maximum.
    await ui(page.getByText('这次评审最多消耗 1,280 积分，实际用多少扣多少。')).toBeVisible();
    await page.getByRole('button', { name: '开始评审' }).dblclick();
    await page.waitForFunction(() => Boolean((window as unknown as { __pushed?: string }).__pushed));
    expect(await page.evaluate(() => (window as unknown as { __pushed?: string }).__pushed)).toBe(`/positioning/${DRAFT}/review/${REVIEW}`);
    expect(calls['fusionReview.start']).toBe(1);
    expect(starts).toEqual([expect.objectContaining({ draftId: DRAFT, sourceVersionId: REVIEW, acceptedCredits: 1280 })]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
  const running = await openEntry({ enabled: true, mine: [mineItem('running')] });
  try {
    await ui(running.page.getByRole('link', { name: '评审团正在审阅，去看看 →' })).toHaveAttribute('href', `/positioning/${DRAFT}/review/${REVIEW}`);
    expect(await running.page.getByRole('button', { name: '请评审团审阅报告' }).count()).toBe(0);
  } finally { await running.page.close(); }
}, 40000);

it('explains a refused start in plain words and keeps the page usable', async () => {
  const { page, errors } = await openEntry({ enabled: true, mine: [mineItem('completed', true)], refuse: 'FUSION_MEMBERSHIP_REQUIRED' });
  try {
    await ui(page.getByRole('link', { name: '评审完成，去逐章选择 →' })).toBeVisible();
    await page.getByRole('button', { name: '请评审团审阅报告' }).click();
    await page.getByRole('button', { name: '开始评审' }).click();
    await ui(page.getByRole('alert')).toHaveText('评审团是会员功能，开通会员后可以使用。');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('says a declined revision was declined, not that every chapter was kept', async () => {
  const { page, errors, calls } = await open('completed');
  try {
    await ui(page.getByRole('heading', { name: '评审团的结果' })).toBeVisible({ timeout: 8000 });
    await page.getByText('采用修订版').first().click();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('button', { name: '放弃这次修改' }).click();
    await ui(page.getByText(/你放弃了这次修改/)).toBeVisible({ timeout: 5000 });
    await ui(page.getByText(/你选择全部保留原文/)).toHaveCount(0);
    expect(calls['fusionReview.confirmAdoption']).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
