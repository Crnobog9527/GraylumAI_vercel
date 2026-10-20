/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// Real browser pages with reloads and retry waits: allow more than the 5-second default per test.
vi.setConfig({ testTimeout: 60_000 });

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__frame_delete_fixture__.js', import.meta.url));
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const WORK_SESSION = '00000000-0000-4000-8000-0000000000b2';
const DRAFT_SESSION = '00000000-0000-4000-8000-0000000000d4';
const DRAFT_PROJECT = '00000000-0000-4000-8000-0000000000e5';
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
        if(location.hash==='#rename-fails')throw Object.assign(new Error('OPC_CONVERSATION_ERASED'),{data:{code:'INTERNAL_SERVER_ERROR',httpStatus:500}});
        if(location.hash==='#rename-hang')return new Promise(()=>undefined);
        if(location.hash==='#rename-slow')await new Promise(resolve=>{window.releaseRename=resolve;});
        return {sessionId:input.sessionId,name:input.name};}}}};
    export const trpc={useUtils:()=>new Proxy({},{get:(_,key)=>key==='client'?client:deep()}),
      opc:{library:{useQuery:()=>q(location.hash==='#strategy'?{businesses:[{businessId:'b1',accounts:[{projectId:'p1',
        platform:'抖音',account:'测试号',strategyDraftId:'d1',sourceVersionId:'v1',sourceVersion:1,items:[]}]}]}
        :location.hash==='#work'?{businesses:[{businessId:'b1',accounts:[{projectId:'p1',platform:'抖音',account:'测试号',
        items:[{workItemId:'w1',sessionId:'${WORK_SESSION}',title:'口播稿工作',brief:null,day:'2026-10-13',revision:1}]}]}]}
        :{accounts:[]})},list:{useQuery:()=>q(location.hash==='#drafts'?{drafts:[
        {draftId:'d-live',sessionId:'${DRAFT_SESSION}',projectId:'p-live',businessName:'咖啡店',state:'draft'},
        {draftId:'d-ro',sessionId:'s-ro',projectId:'${DRAFT_PROJECT}',businessName:'书店',state:'draft',conversationDeleted:true,topicSessionId:'t-ro'}]}:[])},
        conversations:{useQuery:()=>q([{sessionId:'${SESSION}',title:'周末选题讨论',lastActivityAt:'2026-10-13T00:00:00Z'},
          ...(location.hash==='#rename-slow'?[{sessionId:'${OTHER}',title:'第二个对话',lastActivityAt:'2026-10-12T00:00:00Z'}]:[])])},
        workUiChange:{useMutation:m},accountUiChange:{useMutation:m}},
      user:{getUserProfile:{useQuery:()=>q(null)}},ticket:{createTicket:{useMutation:m}},
      fusionReview:{mine:{useQuery:()=>q([])}}};`],
  [id => id.endsWith('/hooks/use-credits'), 'export const useCreditsBalance=()=>({data:undefined});'],
  [id => id.endsWith('/lib/supabase'), 'export const createClient=()=>({auth:{signOut:async()=>{}}});'],
  [id => id === 'next/navigation', `export const usePathname=()=>'/app/runtime';export const useRouter=()=>({push(){},replace(url){window.replaced.push(url)}});`],
  [id => id === 'next/link', `import React from 'react';export default function Link(p){return React.createElement('a',p)}`],
  [id => id.endsWith('/strategy-overview-dialog'), 'export function StrategyOverviewDialog(){return null}'],
  [id => id.endsWith('/use-account-discussion'), 'export const useAccountDiscussion=()=>({opening:false,open(){}});'],
  [id => id.endsWith('/hooks/use-content-erasure'), `export const useContentErasureSync=()=>{};
    export const useAfterContentErasure=()=>async target=>{window.erased.push(target)};`],
  [id => id.endsWith('/content-erasure-dialog'), `import React from 'react';
    export function ContentErasureDialog(p){window.opened.push(p.target);window.openedRelated.push(p.relatedIds??[]);return React.createElement('div',{role:'dialog'},'确认弹窗')}`],
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
        window.opened=[];window.openedRelated=[];window.erasures=[];window.replaced=[];window.erased=[];window.cleanups=[];window.renames=[];
        new BroadcastChannel('graylum-content-erasure').onmessage=event=>window.erased.push(event.data);
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
  // Server refusals carry their tRPC code; a bare network failure carries none (outcome unknown).
  else call.reject(text === 'Failed to fetch' ? new TypeError(text)
    : Object.assign(new Error(text), { data: { code: text.includes('NOT_FOUND') ? 'NOT_FOUND' : 'CONFLICT' } }));
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
    await ui.poll(() => page.evaluate(() => (window as unknown as Win).erased)).toEqual([{ kind: 'session', id: SESSION, relatedIds: [] }]);
    // Physical cleanup starts in the background only after the server confirmed the deletion.
    await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
    await ui(page.getByRole('alert')).toHaveCount(0);
  }));

it('drops the "返回当前工作" link to the deleted conversation before the page leaves', () => open(1280, async page => {
  await page.evaluate(id => sessionStorage.setItem('opc-work-return', '/app/runtime?session=' + id), SESSION);
  await confirmDelete(page);
  // Already gone while the server call is still pending: the start page it lands on never links back.
  expect(await held(page)).toEqual([{ sessionId: SESSION }]);
  expect(await page.evaluate(() => sessionStorage.getItem('opc-work-return'))).toBeNull();
  await answer(page, true);
}));

it('keeps the "返回当前工作" link when it points at other work', () => open(1280, async page => {
  await page.evaluate(() => sessionStorage.setItem('opc-work-return', '/app/positioning/00000000-0000-4000-8000-0000000000ff'));
  await confirmDelete(page);
  await answer(page, true);
  await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
  expect(await page.evaluate(() => sessionStorage.getItem('opc-work-return'))).toBe('/app/positioning/00000000-0000-4000-8000-0000000000ff');
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

it('an unknown outcome keeps the row hidden and sends the deletion again, never claiming success', () => open(1280, async page => {
  await confirmDelete(page);
  await answer(page, false, 'Failed to fetch');
  await ui(page.getByRole('status')).toContainText('删除结果还在确认中');
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  await ui.poll(() => held(page)).toHaveLength(2);
  expect(await page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([]);
  await answer(page, true);
  await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
}));

it('a reload that aborts the deletion request still finishes it on the new page (the 2026-10-14 staging case)', () =>
  open(1280, async page => {
    await confirmDelete(page);
    // The old page sees its request fail as the reload tears it down, then the page reloads.
    await answer(page, false, 'Failed to fetch');
    await reload(page);
    await page.waitForTimeout(2500);
    await ui(page.getByText('周末选题讨论')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { paints: { flashes: number } }).paints.flashes)).toBe(0);
    await ui.poll(() => held(page)).toEqual([{ sessionId: SESSION }]);
    await answer(page, true);
    await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
  }), 60_000); // Includes a 2.5-second watch after the reload.

it('a resumed deletion that keeps failing without an answer stays hidden and pending', () => open(1280, async page => {
  await confirmDelete(page);
  await reload(page);
  for (let i = 0; i < 6; i += 1) {
    await ui.poll(() => held(page)).toHaveLength(i + 1);
    await answer(page, false, 'Failed to fetch');
  }
  await ui(page.getByRole('status')).toContainText('删除还在处理中');
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('pending-conversation-erasure')))).toHaveLength(1);
}), 60_000); // Five 1.5-second retry waits.

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

async function reload(page: Page) {
  // Record every paint after the reload that shows the deleted row, not only the settled state.
  await page.addInitScript(() => {
    const seen = { flashes: 0 };
    (window as unknown as { paints: typeof seen }).paints = seen;
    const tick = () => { if (document.body?.innerText.includes('周末选题讨论')) seen.flashes += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.reload();
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByText('查看归档')).toBeVisible();
}

it('a reload right after deleting keeps the row gone and finishes the deletion', () => open(1280, async page => {
  await confirmDelete(page);
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  // The first request is still in flight (never answered) when the page reloads.
  await reload(page);
  await page.waitForTimeout(300);
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  // Not a single painted frame after the reload showed the row.
  expect(await page.evaluate(() => (window as unknown as { paints: { flashes: number } }).paints.flashes)).toBe(0);
  // The deletion is sent again from the new page (it is idempotent on the server).
  await ui.poll(() => held(page)).toEqual([{ sessionId: SESSION }]);
  await answer(page, true);
  await ui.poll(() => page.evaluate(() => (window as unknown as Win).cleanups)).toEqual([{ sessionId: SESSION }]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('pending-conversation-erasure')))).toEqual([]);
  await reload(page);
  await ui(page.getByText('周末选题讨论')).toBeVisible();
}));

it('a reload during a deletion the server then refuses puts the row back with a reason', () => open(1280, async page => {
  await confirmDelete(page);
  await reload(page);
  await ui.poll(() => held(page)).toHaveLength(1);
  await answer(page, false, 'CONTENT_NOT_FOUND');
  await ui(page.getByText('周末选题讨论')).toBeVisible();
  await ui(page.getByRole('alert')).toContainText('没有确认删除，已放回列表');
}));

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

it('Enter that accepts an IME candidate does not save the name', () => open(1280, async page => {
  const input = await startRename(page);
  await input.fill('周末');
  await input.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
  });
  await ui(input).toBeFocused();
  expect(await renames(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await ui.poll(() => renames(page)).toEqual([{ sessionId: SESSION, name: '周末' }]);
}));

it('a reload right after renaming keeps the new name and sends it again', () => open(1280, async page => {
  const input = await startRename(page);
  await input.fill('刷新前的新名字');
  await page.keyboard.press('Enter');
  await ui.poll(() => renames(page)).toHaveLength(1);
  // The save never answers before the reload (#rename-hang).
  await reload(page);
  await page.waitForTimeout(500);
  await ui(page.getByText('刷新前的新名字', { exact: true })).toBeVisible();
  await ui(page.getByText('周末选题讨论')).toHaveCount(0);
  await ui.poll(() => renames(page)).toEqual([{ sessionId: SESSION, name: '刷新前的新名字' }]);
}, '#rename-hang'));

it('rename input fits a 375px screen', () => open(375, async page => {
  await page.getByRole('button', { name: '打开导航' }).first().click();
  const input = await startRename(page);
  const box = await input.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}));

it('待归类: a live positioning draft deletes its conversation in one click', () => open(1280, async page => {
  await page.evaluate(() => sessionStorage.setItem('opc-edit:d-live', 'UNSAVED_DRAFT_EDIT'));
  // Bring the row into view first: the sidebar closes an open menu when it scrolls.
  const button = page.getByRole('button', { name: '咖啡店 · 定位分析的更多操作' });
  await button.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await button.focus();
  await page.keyboard.press('Enter');
  await ui(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: '删除对话' }).click();
  const dialog = page.getByRole('dialog');
  await ui(dialog).toContainText('删除后无法恢复');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await ui(page.getByRole('dialog')).toHaveCount(0, { timeout: 1000 });
  expect(await held(page)).toEqual([{ sessionId: DRAFT_SESSION }]);
  // Unsaved edits of this draft are kept under its draft ID; they go once the deletion succeeds.
  expect(await page.evaluate(() => sessionStorage.getItem('opc-edit:d-live'))).toBe('UNSAVED_DRAFT_EDIT');
  await answer(page, true);
  await ui.poll(() => page.evaluate(() => sessionStorage.getItem('opc-edit:d-live'))).toBeNull();
  // Other open tabs are told too, with the draft ID, so a tab on the same draft drops its edits.
  await ui.poll(() => page.evaluate(() => (window as unknown as Win).erased))
    .toEqual([{ kind: 'session', id: DRAFT_SESSION, relatedIds: ['d-live'] }]);
}, '#drafts'));

it('待归类: a read-only draft is labelled and offers deleting the whole draft through the work deletion', () => open(1280, async page => {
  await ui(page.getByText('对话已删除 · 只读')).toBeVisible();
  // Bring the row into view first: the sidebar closes an open menu when it scrolls.
  const button = page.getByRole('button', { name: '书店 · 定位分析的更多操作' });
  await button.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await button.focus();
  await page.keyboard.press('Enter');
  await ui(page.getByRole('menu')).toBeVisible();
  await ui(page.getByRole('menuitem', { name: '删除对话' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '永久删除稿件与成果' }).click();
  expect(await page.evaluate(() => (window as unknown as Win).opened.at(-1))).toEqual({ kind: 'artifact', id: DRAFT_PROJECT });
  expect(await page.evaluate(() => (window as unknown as { openedRelated: string[][] }).openedRelated.at(-1))).toEqual(['d-ro', 't-ro']);
}, '#drafts'));

it('reaches the ⋯ button with Tab, which makes it visible', () => open(1280, async page => {
  for (let i = 0; i < 60 && !(await more(page).evaluate(el => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await ui(more(page)).toBeFocused();
  expect(await more(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');
}));
