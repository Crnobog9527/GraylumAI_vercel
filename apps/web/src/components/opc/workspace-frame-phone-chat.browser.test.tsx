/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A phone's conversation page (639px and below; Owner 2026-11-12, phone plan A, screens A3, C1 and C2), in a real browser: the
// real WorkspaceFrame and its CSS around a page shaped like the conversation pages (a log that scrolls, the message box at the
// foot), with the real box frame (ComposerView) and the real phone entry of "多模型对比". The server is a stand-in.
// PHONE_CHAT_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { keyboardInset } from './use-keyboard-inset';

let browser: Browser;
let code = '';
let css = '';
const shots = process.env.PHONE_CHAT_SHOTS;
const entry = fileURLToPath(new URL('./__frame_phone_chat_fixture__.js', import.meta.url));
const stubs: Array<[(id: string) => boolean, string]> = [
  // Every read answers at once; the few the frame and the entry look at have an answer (window.__compare is set per case).
  [id => id.endsWith('/trpc/client'), `
    const answers = () => ({ 'opc.library': { accounts: [] }, 'opc.list': [], 'opc.conversations': [], 'user.getUserProfile': null,
      'fusionReview.mine': [], 'fusionReview.available': { enabled: false }, 'fusionCompare.options': window.__compare });
    const query = data => ({ data, error: null, isPending: false, isSuccess: true, isError: false, refetch: async () => ({}) });
    const mutation = () => ({ isPending: false, mutate() {}, mutateAsync: async () => ({}) });
    const deep = () => new Proxy(() => {}, { get: (_, key) => key === 'then' ? undefined : deep(), apply: () => undefined });
    const node = path => new Proxy({}, { get: (_, key) => key === 'useQuery' ? () => query(answers()[path])
      : key === 'useMutation' ? mutation : node(path + '.' + String(key)) });
    export const trpc = new Proxy({}, { get: (_, key) => key === 'useUtils' ? () => deep() : node(String(key)) });`],
  [id => id.endsWith('/hooks/use-credits'), 'export const useCreditsBalance=()=>({data:undefined});'],
  [id => id.endsWith('/lib/supabase'), 'export const createClient=()=>({auth:{signOut:async()=>{}}});'],
  [id => id === 'next/navigation', `export const usePathname=()=>'/app/runtime';export const useRouter=()=>({push(){},replace(){}});`],
  [id => id === 'next/link', `import React from 'react';export default function Link({prefetch,...p}){return React.createElement('a',p)}`],
  [id => id.endsWith('/strategy-overview-dialog'), 'export function StrategyOverviewDialog(){return null}'],
  [id => id.endsWith('/layout/LanguageSwitch'), 'export function LanguageSwitch(){return null}'],
  [id => id.endsWith('/use-account-discussion'), 'export const useAccountDiscussion=()=>({opening:false,open(){}});'],
  [id => id.endsWith('/hooks/use-content-erasure'), 'export const useContentErasureSync=()=>{};export const useAfterContentErasure=()=>async()=>{};'],
  [id => id.endsWith('/content-erasure-dialog'), 'export function ContentErasureDialog(){return null}'],
  [id => id.endsWith('/paywall/ReportPaywallDialog'), `import React from 'react';
    export function ReportPaywallDialog({scene}){return React.createElement('div',{role:'dialog','aria-label':'付费墙：'+scene},'付费墙')}`],
  [id => id.endsWith('/fusion-review/JuryChooser'), 'export function JuryChooser(){return null}'],
];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'frame-phone-chat-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const index = stubs.findIndex(([match]) => match(id.replace(/\.(tsx?|jsx?)$/, '')));
      if (index >= 0) return '\0stub' + index;
    }, load(id: string) {
      if (id.startsWith('\0stub')) return stubs[Number(id.slice(5))][1];
      if (id !== entry) return;
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { WorkspaceFrame } from ${file('./workspace-frame.tsx')};
        import { ComposerView } from ${file('./composer-view.tsx')};
        import { ComparePhoneEntry } from ${file('../fusion-compare/ComparePhoneEntry.tsx')};
        import { registerCompareHost } from ${file('../fusion-compare/compare-entry.ts')};
        const h = React.createElement, query = new URLSearchParams(location.search);
        window.asked = 0; registerCompareHost(() => { window.asked += 1; });
        // The shape of the conversation pages (runtime/turn-workspace.tsx): a column with the log that scrolls and the box at its foot.
        const page = h('main', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          h('div', { 'aria-label': '对话记录', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 } },
            Array.from({ length: 40 }, (_, index) => h('p', { key: index }, '第 ' + (index + 1) + ' 条消息'))),
          h('footer', { style: { flex: 'none', padding: '8px 12px' } }, h(ComposerView, { fileHint: '',
            editor: h('div', { contentEditable: true, role: 'textbox', 'aria-label': '消息', suppressContentEditableWarning: true,
              style: { minHeight: 50 } }),
            tools: h(ComparePhoneEntry) })));
        createRoot(document.getElementById('root')).render(h(WorkspaceFrame, { area: query.get('area') || 'chat',
          right: query.has('right') ? h('div', { style: { padding: 16 } }, '定位清单的内容') : undefined }, page));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'FramePhoneChatTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = output.filter(item => item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

type Compare = { enabled: true } | { enabled: false; reason: string } | undefined;
async function open(width: number, query = '', compare: Compare = { enabled: true }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const body = '<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>*{box-sizing:border-box}body{margin:0}</style></head><body><div id="root"></div></body></html>';
  await page.route('**/*', route => (new URL(route.request().url()).pathname === '/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.abort()));
  await page.goto('http://frame.test/' + query);
  await page.evaluate(value => { (window as unknown as { __compare: unknown }).__compare = value; }, compare);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await page.getByRole('textbox', { name: '消息' }).waitFor();
  return { page, errors };
}
const box = async (page: Page, selector: string) => page.locator(selector).first().evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), width: Math.round(rect.width) };
});
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

it('the keyboard is told from the browser\'s own bars: a small difference is not a keyboard', () => {
  expect(keyboardInset(800, 800)).toBe(0);
  expect(keyboardInset(800, 744)).toBe(0);
  expect(keyboardInset(800, 480)).toBe(320);
  // Zoomed in with two fingers, less of the page shows as well: not a keyboard.
  expect(keyboardInset(800, 400, 2)).toBe(0);
});

for (const width of [390, 360]) {
  it(`${width}px: the conversation is the whole screen, with a way back on top and the message box at the foot`, async () => {
    const { page, errors } = await open(width);
    try {
      if (shots) await page.screenshot({ path: `${shots}/chat-${width}.png` });
      // No site bar, no announcement, no bottom bar: one row with the way back to the list of conversations.
      await ui(page.locator('header').first()).toBeHidden();
      await ui(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
      const back = page.getByRole('link', { name: '对话' });
      await ui(back).toBeVisible();
      expect(await back.getAttribute('href')).toBe('/app/chats');
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await back.boundingBox())!.y).toBeLessThan(8);
      // The page reaches all four edges; the box is inside the screen, at its foot; the log between scrolls on its own.
      const main = await box(page, 'main');
      expect([main.left, main.width, main.bottom]).toEqual([0, width, 800]);
      expect(main.top).toBe(48);
      const send = await page.getByRole('button', { name: '发送' }).boundingBox();
      expect(send!.y + send!.height).toBeLessThanOrEqual(800);
      expect(send!.y + send!.height).toBeGreaterThan(800 - 48);
      expect(await page.getByLabel('对话记录').evaluate(log => log.scrollHeight > log.clientHeight)).toBe(true);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('with the on-screen keyboard up, the page ends where the keyboard begins: the message box stays in view, the way back stays on top', async () => {
  const { page, errors } = await open(390);
  try {
    // What use-keyboard-inset.ts writes when the keyboard covers 320px (a headless browser has no keyboard to show).
    await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-inset', '320px'));
    const send = await page.getByRole('button', { name: '发送' }).boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(480);
    expect(send!.y + send!.height).toBeGreaterThan(480 - 48);
    expect((await box(page, 'main')).bottom).toBe(480);
    expect((await page.getByRole('link', { name: '对话' }).boundingBox())!.y).toBeLessThan(8);
    if (shots) await page.screenshot({ path: `${shots}/chat-keyboard-390.png` });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('the right panel (the positioning checklist) opens from the top row\'s right end and rises from the bottom edge', async () => {
  const { page, errors } = await open(390, '?right=1');
  try {
    const toggle = page.getByRole('button', { name: '展开右边栏' });
    const place = await toggle.boundingBox();
    expect([place!.width, place!.height]).toEqual([44, 44]);
    expect(place!.y + place!.height).toBeLessThanOrEqual(48);
    expect(place!.x + place!.width).toBeGreaterThan(390 - 12);
    const panel = page.getByRole('complementary', { name: '当前成果' });
    await ui(panel).toBeHidden();
    await toggle.click();
    await ui(panel).toBeVisible();
    await page.waitForFunction(() => document.querySelector('aside[aria-label="当前成果"]')!.getAnimations().every(a => a.playState === 'finished'));
    if (shots) await page.screenshot({ path: `${shots}/checklist-390.png` });
    const sheet = await box(page, 'aside[aria-label="当前成果"]');
    expect([sheet.left, sheet.width, sheet.bottom]).toEqual([0, 390, 800]);
    expect(sheet.top, 'the conversation stays visible above the sheet').toBeGreaterThanOrEqual(56);
    expect(await panel.evaluate(element => [getComputedStyle(element).borderTopLeftRadius, getComputedStyle(element).borderBottomLeftRadius]))
      .toEqual(['24px', '0px']);
    await ui(panel).toContainText('定位清单的内容');
    await page.getByRole('button', { name: '收起成果面板' }).click();
    await ui(panel).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('"多模型对比" stands in the box\'s row of tools on a phone and asks the page, as the rail\'s entry does on a computer', async () => {
  const { page, errors } = await open(390);
  try {
    const entry = page.getByRole('button', { name: '多模型对比' });
    await ui(entry).toBeVisible();
    const [chip, add, send] = await Promise.all([entry.boundingBox(), page.getByRole('button', { name: '添加资料' }).boundingBox(),
      page.getByRole('button', { name: '发送' }).boundingBox()]);
    // In the same row as the round buttons, between them and the send button.
    expect(Math.abs((chip!.y + chip!.height / 2) - (add!.y + add!.height / 2))).toBeLessThanOrEqual(1);
    expect(chip!.x).toBeGreaterThan(add!.x + add!.width);
    expect(chip!.x + chip!.width).toBeLessThan(send!.x);
    await entry.click();
    expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(1);
    await ui(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a plan without the tool: the phone entry opens the tool\'s paywall; the tool switched off for the site: no entry', async () => {
  const lacking = await open(390, '', { enabled: false, reason: 'plan' });
  try {
    await lacking.page.getByRole('button', { name: '多模型对比' }).click();
    await ui(lacking.page.getByRole('dialog', { name: '付费墙：compare' })).toBeVisible();
    expect(await lacking.page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(0);
    expect(lacking.errors).toEqual([]);
  } finally { await lacking.page.close(); }
  const off = await open(390, '', { enabled: false, reason: 'disabled' });
  try {
    await ui(off.page.getByRole('button', { name: '多模型对比' })).toHaveCount(0);
    expect(off.errors).toEqual([]);
  } finally { await off.page.close(); }
}, 30000);

it('the new-conversation page on a phone keeps the site bar and the bottom bar: only the conversation pages fill the screen', async () => {
  const { page, errors } = await open(390, '?area=start');
  try {
    await ui(page.locator('header').first()).toBeVisible();
    await ui(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await ui(page.getByRole('link', { name: '对话', exact: true }).and(page.locator('[href="/app/chats"]:not([aria-current])'))).toHaveCount(0);
    expect((await box(page, 'main')).bottom).toBeLessThanOrEqual(800 - 56);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('1280px: the conversation page is what it was: the site bar, the rail, no back row, and the entry only in the rail', async () => {
  const { page, errors } = await open(1280);
  try {
    await ui(page.locator('header').first()).toBeVisible();
    await ui(page.getByRole('link', { name: '对话', exact: true }).and(page.locator('[href="/app/chats"]'))).toBeHidden();
    // One visible "多模型对比": the rail's. The box's own is not drawn on a computer.
    const entries = page.getByRole('button', { name: '多模型对比' });
    await ui(entries).toHaveCount(1);
    expect((await entries.boundingBox())!.x).toBeLessThan(264);
    expect((await box(page, 'main')).left).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
