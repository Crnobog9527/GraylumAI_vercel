/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__frame_delete_fixture__.js', import.meta.url));
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const WORK_SESSION = '00000000-0000-4000-8000-0000000000b2';
const OTHER = '00000000-0000-4000-8000-0000000000c3';

// Everything around the list is stubbed. The deletion call is held by the page (window.erasures), so a
// test decides when and how the server answers and can check what the list shows meanwhile.
const stubs: Array<[(id: string) => boolean, string]> = [
  [id => id.endsWith('/trpc/client'), `const q=data=>({data,error:null,isPending:false,isSuccess:true,refetch:async()=>{}});
    const m=()=>({isPending:false,mutate(){},mutateAsync:async()=>({})});
    // Any utils path (utils.opc.conversations.setData…) is a no-op; the list itself stays static.
    const deep=()=>new Proxy(()=>{},{get:(_,key)=>key==='then'?undefined:deep(),apply:()=>undefined});
    const client={account:{conversationErasure:{mutate:input=>new Promise((resolve,reject)=>
      window.erasures.push({input,resolve,reject}))},
      conversationErasureCleanup:{mutate:async input=>{window.cleanups.push(input);
        return {cleaned:true,reviewRequired:location.hash==='#review'};}}},
      opc:{conversationRename:{mutate:async input=>{window.renames.push(input);
        if(location.hash==='#rename-fails')throw new Error('OPC_CONVERSATION_ERASED');
        if(location.hash==='#rename-slow')await new Promise(resolve=>{window.releaseRename=resolve;});
        return {sessionId:input.sessionId,name:input.name};}}}};
    export const trpc={useUtils:()=>new Proxy({},{get:(_,key)=>key==='client'?client:deep()}),
      opc:{library:{useQuery:()=>q(location.hash==='#strategy'?{businesses:[{businessId:'b1',accounts:[{projectId:'p1',
        platform:'抖音',account:'测试号',strategyDraftId:'d1',sourceVersionId:'v1',sourceVersion:1,items:[]}]}]}
        :location.hash==='#work'?{businesses:[{businessId:'b1',accounts:[{projectId:'p1',platform:'抖音',account:'测试号',
        items:[{workItemId:'w1',sessionId:'${WORK_SESSION}',title:'口播稿工作',brief:null,day:'2026-10-13',revision:1}]}]}]}
        :{accounts:[]})},list:{useQuery:()=>q([])},
        conversations:{useQuery:()=>q([{sessionId:'${SESSION}',title:'周末选题讨论',lastActivityAt:'2026-10-13T00:00:00Z'},
          ...(location.hash==='#rename-slow'?[{sessionId:'${OTHER}',title:'第二个对话',lastActivityAt:'2026-10-12T00:00:00Z'}]:[])])},
        workUiChange:{useMutation:m},accountUiChange:{useMutation:m}},
      user:{getUserProfile:{useQuery:()=>q(null)}},ticket:{createTicket:{useMutation:m}}};`],
  [id => id.endsWith('/hooks/use-credits'), 'export const useCreditsBalance=()=>({data:undefined});'],
  [id => id.endsWith('/lib/supabase'), 'export const createClient=()=>({auth:{signOut:async()=>{}}});'],
  [id => id === 'next/navigation', `export const usePathname=()=>'/runtime';export const useRouter=()=>({push(){},replace(url){window.replaced.push(url)}});`],
  [id => id === 'next/link', `import React from 'react';export default function Link(p){return React.createElement('a',p)}`],
  [id => id.endsWith('/strategy-overview-dialog'), 'export function StrategyOverviewDialog(){return null}'],
  [id => id.endsWith('/use-account-discussion'), 'export const useAccountDiscussion=()=>({opening:false,open(){}});'],
  [id => id.endsWith('/hooks/use-content-erasure'), `export const useContentErasureSync=()=>{};
    export const useAfterContentErasure=()=>async target=>{window.erased.push(target)};`],
  [id => id.endsWith('/content-erasure-dialog'), `import React from 'react';
    export function ContentErasureDialog(p){window.opened.push(p.target);return React.createElement('div',{role:'dialog'},'确认弹窗')}`],
];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const source = fileURLToPath(new URL('./workspace-frame.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'frame-delete-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const index = stubs.findIndex(([match]) => match(id));
      if (index >= 0) return '\0stub' + index;
    }, load(id: string) {
      if (id.startsWith('\0stub')) return stubs[Number(id.slice(5))][1];
      if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {WorkspaceFrame} from ${JSON.stringify(source)};
        window.opened=[];window.erasures=[];window.replaced=[];window.erased=[];window.cleanups=[];window.renames=[];
        const root=createRoot(document.getElementById('root'));
        const frame=()=>React.createElement(WorkspaceFrame,null,'对话内容');
        root.render(frame());
        // Like leaving the page: the old frame unmounts and a new page mounts its own frame.
        window.remount=()=>{root.render(null);setTimeout(()=>root.render(frame()),0);};`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'FrameDeleteTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(width: number, run: (page: Page) => Promise<void>, hash = '') {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // A real origin, so the frame can use sessionStorage/localStorage; nothing leaves the test.
    await page.route('**/*', route => route.request().url() === 'http://frame.test/'
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
    await page.goto('http://frame.test/' + hash);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await ui(page.getByText('周末选题讨论')).toBeAttached();
    expect(errors).toEqual([]);
    await run(page);
  } finally {
    await page.close();
  }
}
const more = (page: Page) => page.getByRole('button', { name: '周末选题讨论的更多操作' });

type Held = { input: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };
type Win = { opened: unknown[]; erasures: Held[]; replaced: string[]; erased: unknown[]; cleanups: unknown[]; renames: unknown[] };
const held = (page: Page) => page.evaluate(() => (window as unknown as Win).erasures.map(item => item.input));
const answer = (page: Page, ok: boolean, message = '') => page.evaluate(([okay, text]) => {
  const call = (window as unknown as Win).erasures.at(-1)!;
  if (okay) call.resolve({ kind: 'session', id: (call.input as { sessionId: string }).sessionId, status: text || 'deleted',
    alreadyDeleted: false, preservedSavedVersions: 0, financialReviewCount: 0 });
  else call.reject(new Error(text));
}, [ok, message] as const);

async function openMenu(page: Page) {
  await more(page).focus();
  await page.keyboard.press('Enter');
}

async function confirmDelete(page: Page) {
  await openMenu(page);
  await page.getByRole('menuitem', { name: '删除对话' }).click();
  const dialog = page.getByRole('dialog');
  await ui(dialog).toContainText('删除后无法恢复');
  await ui(dialog).not.toContainText('影响');
  // Clickable at once: no preview request runs first.
  await ui(dialog.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
}

it.each([1280, 375])('removes the row and closes the dialog at once, before the server answers (%ipx)', width =>
  open(width, async page => {
    if (width === 375) await page.getByRole('button', { name: '打开导航' }).first().click();
    await confirmDelete(page);
    // Within one second the row is gone and the dialog closed, while the server call is still pending.
    await ui(page.getByText('周末选题讨论')).toHaveCount(0, { timeout: 1000 });
    await ui(page.getByRole('dialog')).toHaveCount(0, { timeout: 1000 });
    expect(await held(page)).toEqual([{ sessionId: SESSION }]);
    expect(await page.evaluate(() => (window as unknown as Win).opened)).toEqual([]);
    await answer(page, true);
    await ui(page.getByText('周末选题讨论')).toHaveCount(0);
    await ui.poll(() => page.evaluate(() => (window as unknown as Win).erased)).toEqual([{ kind: 'session', id: SESSION }]);
    // Physical cleanup starts in the background only after the server confirmed the deletion.
    await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
    await ui(page.getByRole('alert')).toHaveCount(0);
  }));

it('puts the row back with a plain reason when the server refuses, and never reports success', () => open(1280, async page => {
  await confirmDelete(page);
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  await answer(page, false, 'CONTENT_ERASURE_BUSY');
  await ui(page.getByText('周末选题讨论')).toBeVisible();
  await ui(page.getByRole('alert')).toContainText('没有删除，已放回列表');
  expect(await page.evaluate(() => (window as unknown as Win).erased)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([]);
}));

it('keeps the row hidden and still reports a failure after the page changes mid-deletion', () => open(1280, async page => {
  await confirmDelete(page);
  await page.evaluate(() => (window as unknown as { remount: () => void }).remount());
  await ui(page.getByText('对话内容')).toBeAttached();
  await ui(page.getByText('查看归档')).toBeVisible();
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  await answer(page, false, 'CONTENT_ERASURE_BUSY');
  await ui(page.getByText('周末选题讨论')).toBeVisible();
  await ui(page.getByRole('alert')).toContainText('没有删除，已放回列表');
}));

it('keeps an uncertain result honest: row back, list resynced, no success claim', () => open(1280, async page => {
  await confirmDelete(page);
  await answer(page, false, 'Failed to fetch');
  await ui(page.getByText('周末选题讨论')).toBeVisible();
  await ui(page.getByRole('alert')).toContainText('删除结果暂未确认');
}));

it('says so when the content is gone but money records are still being checked', () => open(1280, async page => {
  await confirmDelete(page);
  await answer(page, true, 'review_required');
  await ui(page.getByRole('status')).toContainText('部分账务记录仍在核对中');
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
}));

it('shows the accounting notice when the background cleanup finds money still being checked', () => open(1280, async page => {
  await confirmDelete(page);
  await answer(page, true);
  await ui(page.getByRole('status')).toContainText('部分账务记录仍在核对中');
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
}, '#review'));

it('cancel keeps the conversation and sends nothing', () => open(1280, async page => {
  await openMenu(page);
  await page.getByRole('menuitem', { name: '删除对话' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await ui(page.getByText('周末选题讨论')).toBeVisible();
  expect(await held(page)).toEqual([]);
}));

it('Esc closes the ⋯ menu and puts focus back on the ⋯ button', () => open(1280, async page => {
  await openMenu(page);
  await ui(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: '删除对话' }).focus();
  await page.keyboard.press('Escape');
  await ui(page.getByRole('menu')).toHaveCount(0, { timeout: 1000 });
  await ui(more(page)).toBeFocused();
  await ui(more(page)).toHaveAttribute('aria-expanded', 'false');
}));

it('Esc on the strategy menu returns focus to its own button, not an earlier row', () => open(1280, async page => {
  await openMenu(page);
  await page.keyboard.press('Escape');
  const strategy = page.getByRole('button', { name: /定位策略的更多操作/ });
  await strategy.focus();
  await page.keyboard.press('Enter');
  await ui(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await ui(page.getByRole('menu')).toHaveCount(0);
  await ui(strategy).toBeFocused();
}, '#strategy'));

it('deletes a work conversation through the same one-click dialog; the work itself stays', () => open(1280, async page => {
  await page.getByRole('button', { name: '口播稿工作的更多操作' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '永久删除对话记录' }).click();
  const dialog = page.getByRole('dialog');
  await ui(dialog).toContainText('删除后无法恢复');
  await ui(dialog.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await ui(page.getByRole('dialog')).toHaveCount(0, { timeout: 1000 });
  expect(await held(page)).toEqual([{ sessionId: WORK_SESSION }]);
  expect(await page.evaluate(() => (window as unknown as Win).opened)).toEqual([]);
  await ui(page.getByText('口播稿工作')).toBeVisible();
}, '#work'));

const renames = (page: Page) => page.evaluate(() => (window as unknown as Win).renames);
async function startRename(page: Page) {
  await openMenu(page);
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const input = page.getByRole('textbox', { name: '重命名对话' });
  await ui(input).toHaveValue('周末选题讨论');
  await ui(input).toBeFocused();
  return input;
}

it('renames a conversation inline from the ⋯ menu; Enter saves the trimmed name', () => open(1280, async page => {
  const input = await startRename(page);
  await input.fill('  新名字  ');
  await page.keyboard.press('Enter');
  await ui(input).toHaveCount(0);
  await ui.poll(() => renames(page)).toEqual([{ sessionId: SESSION, name: '新名字' }]);

}));

it('Esc cancels a rename without saving, and an unchanged name sends nothing', () => open(1280, async page => {
  let input = await startRename(page);
  await input.fill('不保存');
  await page.keyboard.press('Escape');
  await ui(input).toHaveCount(0);
  input = await startRename(page);
  await page.keyboard.press('Enter');
  await ui(input).toHaveCount(0);
  expect(await renames(page)).toEqual([]);
}));

it('a refused rename keeps the old title and explains why', () => open(1280, async page => {
  const input = await startRename(page);
  await input.fill('已删的对话');
  await page.keyboard.press('Enter');
  await ui(page.getByRole('alert')).toContainText('这个对话已删除，不能重命名');
  await ui(page.getByText('周末选题讨论')).toBeVisible();
}, '#rename-fails'));

it('a second conversation saves while the first rename is still pending', () => open(1280, async page => {
  let input = await startRename(page);
  await input.fill('第一个');
  await page.keyboard.press('Enter');
  await ui.poll(() => renames(page)).toHaveLength(1);
  // The name being saved is shown at once, on top of the server list.
  await ui(page.getByText('第一个', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第二个对话的更多操作' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名' }).click();
  input = page.getByRole('textbox', { name: '重命名对话' });
  await input.fill('第二个');
  await page.getByText('查看归档').click();
  await ui(input).toHaveCount(0);
  await ui.poll(() => renames(page)).toEqual([{ sessionId: SESSION, name: '第一个' }, { sessionId: OTHER, name: '第二个' }]);
  await page.evaluate(() => (window as unknown as { releaseRename?: () => void }).releaseRename?.());
}, '#rename-slow'));

it('rename input fits a 375px screen', () => open(375, async page => {
  await page.getByRole('button', { name: '打开导航' }).first().click();
  const input = await startRename(page);
  const box = await input.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}));

it('reaches the ⋯ button with Tab, which makes it visible', () => open(1280, async page => {
  for (let i = 0; i < 60 && !(await more(page).evaluate(el => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await ui(more(page)).toBeFocused();
  expect(await more(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');
}));
