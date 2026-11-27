/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The positioning conversation keeps room to read (Owner's new-account run, 2026-11-26): with the step's confirmation card above
// the box and a question card docked in it, the message list had shrunk to about one sentence, and the confirmation card's list
// covered the conversation. In a real browser, the real page and its CSS, built as phone-keyboard.browser.test.tsx builds it;
// the frame is a stand-in with the geometry a conversation page has (the whole screen less a 48px row on top).
// Second round (Owner's real-model run, 2026-11-27): at 1280x800 the list was still only about 190px and at 360x640 the card's
// content scrolled away; the complete card is now one folded line until opened, the list keeps half the step on a desktop and
// 180px on a phone.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__conversation_room_fixture__.js', import.meta.url));
const long = (label: string) => `${label}：` + '下班后二十分钟做好一顿家常晚餐，少洗碗，食材在楼下超市就能买齐。'.repeat(3);
const fields = ['目标', '受众', '平台', '时间', '已有条件', '内容方向'].map((title, index) => ({ id: 'f' + index, title, required: true }));
const ready = Object.fromEntries(fields.map(field => [field.id, { value: long(field.title), status: 'provisional', nature: 'fact' }]));
const missing = { ...ready, f4: { value: '', status: 'unknown', nature: 'unknown' }, f5: { value: '', status: 'unknown', nature: 'unknown' } };
const fixture = (values: Record<string, unknown>) => ({ draftId: 'draft', projectId: 'project', roundId: 'round', sessionId: '00000000-0000-4000-8000-000000000001',
  mode: 'mentor', plans: [], turns: [], runtimeMode: 'staging_test',
  snapshot: { state: 'draft', workflow: { steps: [{ id: 's', title: '了解你' }, { id: 't', title: '诊断与对标' }] },
    steps: { s: { version: 1, reviewVersion: 0, valid: false }, t: { version: 1, reviewVersion: 0, valid: false } } },
  information: { s: { schema: fields, values, meta: {} }, t: { schema: [{ id: 'g', title: '对标', required: true }], values: {}, meta: {} } } });
const card = { question: '你每周大概能拿出多少时间做这个账号？', options: ['3 小时以内', '3 到 6 小时', '6 小时以上'], recommended: null,
  message: '下面是中性的范围或类别，请按实际情况选择。', recommendationReason: null };
// The host's fixed goal question (Owner 2026-11-27 option C), five options: the most a fixed card has.
const goalCard = { question: '你做这个账号，最希望它最后带来什么？', options: ['每月多份零花钱', '给生意带客户', '慢慢做成主业', '卖课程或产品', '先试试适不适合'],
  recommended: null, message: '你做这个账号，最希望它最后带来什么？', recommendationReason: null };
const reply = (text: string, shown: typeof card | null) =>
  JSON.stringify({ format: 'agent-turn.v1', message: text, card: shown, stepId: 's', roundId: 'round' });
const messages = (withCard: boolean, shown = card) => Array.from({ length: 6 }, (_, index) => [
  { seq: index * 2 + 1, role: 'user', turnId: index + 1, content: `第 ${index + 1} 轮：` + '我是上海的上班族，想做小红书快手晚餐。'.repeat(2) },
  { seq: index * 2 + 2, role: 'assistant', turnId: index + 1,
    content: reply(`第 ${index + 1} 段回复。` + '我们先把你的目标和受众说清楚，再看平台和时间。'.repeat(4), withCard && index === 5 ? shown : null) },
]).flat();

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const positioning = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'room-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link' ||
          id.endsWith('/components/opc/workspace-frame')) return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}}); export const useParams=()=>({draftId:'draft'});
          export const usePathname=()=>'/app/positioning/draft'; export const useSearchParams=()=>new URLSearchParams();`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/components/opc/workspace-frame')) return `import React from 'react';
          const shell={height:'100dvh',display:'flex',flexDirection:'column',overflow:'hidden',background:'#fff'};
          const row={height:48,boxSizing:'border-box',flex:'none',borderBottom:'1px solid #f0f0f0',padding:'12px 10px'};
          const body={flex:1,minHeight:0,display:'flex'};
          const side={width:'min(380px,40vw)',flex:'none',overflow:'auto',borderLeft:'1px solid #eee'};
          export function WorkspaceFrame(p){return React.createElement('div',{style:shell},
            React.createElement('div',{style:row},'‹ 对话'),React.createElement('div',{style:body},
              React.createElement('div',{style:{flex:1,minWidth:0,minHeight:0}},p.children),
              p.right&&p.rightOpen&&(innerWidth>=640||p.revealRight)?React.createElement('aside',{style:innerWidth>=640?side:
                {position:'fixed',inset:'48px 0 0 0',overflow:'auto',background:'#fff'},'aria-label':'当前成果'},p.right):null))}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{getSession:async()=>({data:{session:{user:{id:'u'}}},error:null}),
          onAuthStateChange:cb=>{cb('INITIAL_SESSION',{user:{id:'u'}});return {data:{subscription:{unsubscribe:()=>{}}}}}}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import PositioningDraft from ${JSON.stringify(positioning)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://room.test/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(React.Suspense,{fallback:'加载'},
              React.createElement(PositioningDraft,{params:Promise.resolve({draftId:'draft'})})))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'ConversationRoomTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(width: number, height: number, state: { values: Record<string, unknown>; withCard: boolean; card?: typeof card }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = fixture(state.values);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div>' });
    if (path === '/api/turn') return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ activeTurn: null, lastTurn: null, messages: messages(state.withCard, state.card), calls: [] }) });
    const result = path.endsWith('/opc.read') ? data : path.endsWith('/runtime.choices') ? {}
      : path.endsWith('/opc.businesses') ? [] : path.endsWith('/opc.list') ? { drafts: [] } : path.endsWith('/opc.library') ? { businesses: [] }
        : path.endsWith('/opc.capturePending') ? { processed: [] } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
  });
  await page.goto('http://room.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await page.getByRole('textbox', { name: '给 AI 教练的回复' }).waitFor();
  await ui(page.getByText('第 6 段回复', { exact: false })).toBeVisible();
  return { page, errors };
}

/** The part of the message list on screen, uncovered: its box clipped to the viewport, less anything drawn over it. */
const logRoom = (page: Page) => page.evaluate(() => {
  const log = document.querySelector('[role=log][aria-label="完整 AI 教练消息"]')!;
  const box = log.getBoundingClientRect();
  const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, innerHeight);
  let covered = 0;
  for (let y = Math.ceil(top) + 1; y < bottom - 1; y += 4) {
    const hit = document.elementFromPoint(box.left + box.width / 2, y);
    if (hit && !log.contains(hit)) covered += 4;
  }
  return { visible: Math.max(bottom - top, 0), covered, scrollable: log.scrollHeight > log.clientHeight };
});

/** On screen, and the topmost thing at its centre is the element itself (a click lands on it). */
const reachable = (target: import('@playwright/test').Locator) => target.evaluate(element => {
  const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + Math.min(box.height / 2, 20);
  const hit = document.elementFromPoint(x, y);
  return box.height > 0 && y >= 0 && y <= innerHeight && Boolean(hit && (element === hit || element.contains(hit)));
});

/**
 * Room to read: on a desktop, half the step's own height (the area under the step tabs) for the list together with a docked
 * question card (the coach's latest question, scrolling in its own frame); on a phone, 180px for the list itself.
 */
const SIZES: Array<[number, number, number | 'half']> = [[1440, 900, 'half'], [1280, 800, 'half'], [390, 844, 180], [360, 640, 180]];
const stepHeight = (page: Page) => page.evaluate(() => document.querySelector('section[aria-label="当前定位步骤"]')!.getBoundingClientRect().height);
for (const [width, height, floor] of SIZES) {
  for (const state of [{ name: 'step ready (every field listed) and a docked question card', values: ready, withCard: true },
    { name: 'two fields still missing', values: missing, withCard: false }]) {
    it(`${width}x${height}, ${state.name}: the message list keeps ${floor === 'half' ? 'half the step' : floor + 'px'} on screen, uncovered`, async () => {
      const { page, errors } = await open(width, height, state);
      try {
        await ui(page.getByRole('region', { name: '本步确认' })).toBeVisible();
        const minimum = floor === 'half' ? Math.floor(await stepHeight(page) / 2) : floor;
        // The complete card is one line until it is opened.
        if (state.values === ready) expect((await page.getByRole('region', { name: '本步确认' }).boundingBox())!.height,
          'folded confirmation card').toBeLessThanOrEqual(56);
        if (state.withCard) await ui(page.getByRole('button', { name: '3 到 6 小时' })).toBeVisible();
        const room = await logRoom(page);
        const docked = floor === 'half' ? await page.evaluate(() =>
          document.querySelector('[data-question-card]')?.parentElement?.getBoundingClientRect().height ?? 0) : 0;
        expect(room.visible + docked, 'visible height of the message list (and the docked question)').toBeGreaterThanOrEqual(minimum);
        expect(room.covered, 'pixels of the message list covered by something else').toBe(0);
        // The box, and the step card's buttons, are on screen and nothing is drawn over them.
        // A short phone (360x640) with both cards scrolls the step as a whole to reach them.
        for (const [name, target] of [['message box', page.getByRole('textbox', { name: '给 AI 教练的回复' })],
          ['send', page.getByRole('button', { name: '发送', exact: true })],
          ['step card button', page.getByRole('region', { name: '本步确认' }).getByRole('button').first()]] as const) {
          if (height < 700) await target.scrollIntoViewIfNeeded();
          expect(await reachable(target), name).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 60000);
  }
}

it('the confirmation card\'s buttons work: "去右侧补充" opens the checklist at the first missing field', async () => {
  const { page, errors } = await open(1280, 800, { values: missing, withCard: false });
  try {
    const region = page.getByRole('region', { name: '本步确认' });
    const add = region.getByRole('button', { name: '去右侧补充' });
    await ui(add).toBeEnabled();
    await add.click();
    await ui(page.locator('#s-f4')).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60000);

it('the confirmation card\'s "暂时无法确定，写原因暂缓" opens the step review on a phone, above the box', async () => {
  const { page, errors } = await open(390, 844, { values: missing, withCard: false });
  try {
    const defer = page.getByRole('region', { name: '本步确认' }).getByRole('button', { name: '暂时无法确定，写原因暂缓' });
    await ui(defer).toBeEnabled();
    expect(await reachable(defer)).toBe(true);
    await defer.click();
    await ui(page.getByRole('dialog')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60000);

for (const [width, height] of [[1280, 800], [360, 640]] as const) {
  it(`${width}x${height}: the folded card opens to every value, and only then confirms; it folds again`, async () => {
    const { page, errors } = await open(width, height, { values: ready, withCard: true });
    try {
      const region = page.getByRole('region', { name: '本步确认' });
      await ui(region.getByRole('button', { name: '没问题，进入下一步' })).toHaveCount(0);
      await region.getByRole('button', { name: '展开核对' }).click();
      for (const field of fields) await ui(region.getByText(long(field.title))).toHaveCount(1);
      const confirm = region.getByRole('button', { name: '没问题，进入下一步' });
      await confirm.scrollIntoViewIfNeeded();
      expect(await reachable(confirm), 'confirm button of the opened card').toBe(true);
      // The box and send stay reachable with the card open (the step scrolls as a whole on a short phone).
      await page.getByRole('button', { name: '发送', exact: true }).scrollIntoViewIfNeeded();
      expect(await reachable(page.getByRole('button', { name: '发送', exact: true })), 'send').toBe(true);
      await region.getByRole('button', { name: '收起' }).click();
      await ui(region.getByRole('button', { name: '展开核对' })).toBeVisible();
      await page.getByRole('log', { name: '完整 AI 教练消息' }).scrollIntoViewIfNeeded();
      expect((await logRoom(page)).visible).toBeGreaterThanOrEqual(180);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
}

/**
 * Directly visible: inside the viewport and inside every box that clips it (a scrolling frame shows it without being scrolled),
 * and the topmost thing at its centre is the element itself.
 */
const inView = (target: import('@playwright/test').Locator) => target.evaluate(element => {
  const box = element.getBoundingClientRect();
  let top = 0, bottom = innerHeight;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const clip = node.getBoundingClientRect();
      top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    }
  }
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return { inside: box.height > 0 && box.top >= top - 0.5 && box.bottom <= bottom + 0.5, top: box.top, bottom: box.bottom, clipTop: top,
    clipBottom: bottom, onTop: Boolean(hit && (element === hit || element.contains(hit))) };
});

// Defect E (Owner 2026-11-27, #2060 run): with the step's missing-fields card above the box, the docked card showed only its
// first option ("每月多份零花钱"); the rest scrolled inside a frame cut to about 100px, with no sign there was more. Every option
// and "其他" must now be on screen without scrolling anything, at the four sizes.
for (const [width, height] of SIZES) {
  it(`${width}x${height}, two fields missing and the five-option goal card docked: every option is directly visible`, async () => {
    const { page, errors } = await open(width, height, { values: missing, withCard: true, card: goalCard });
    try {
      const options = page.getByRole('region', { name: 'AI 教练提问' }).getByRole('group', { name: '建议选项' }).getByRole('button');
      await ui(options).toHaveCount(6);
      for (const label of [...goalCard.options, '其他']) {
        const seen = await inView(options.filter({ hasText: label }).first());
        expect(seen, `${label} at ${width}x${height}: ${JSON.stringify(seen)}`).toMatchObject({ inside: true, onTop: true });
      }
      // The box and the missing-fields card's buttons stay on screen too (the step scrolls as a whole only on a short phone).
      for (const target of [page.getByRole('textbox', { name: '给 AI 教练的回复' }),
        page.getByRole('region', { name: '本步确认' }).getByRole('button').first()]) {
        if (height < 700) await target.scrollIntoViewIfNeeded();
        expect(await reachable(target)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
}
