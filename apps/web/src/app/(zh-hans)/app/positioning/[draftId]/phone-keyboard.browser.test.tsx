/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The positioning conversation on a phone with the on-screen keyboard up (Owner 2026-11-12, phone plan A: "键盘弹出不遮挡"), in a
// real browser: the real page and its CSS, built the way information-export.browser.test.tsx builds it (the server answers from
// a fixture). The frame is a stand-in with the geometry workspace-frame.module.css gives a conversation page on a phone: the
// whole screen less what the keyboard covers, with a 48px row on top (that geometry itself is measured with the real frame in
// components/opc/workspace-frame-phone-chat.browser.test.tsx). A headless browser has no keyboard, so the test writes what
// use-keyboard-inset.ts would: --keyboard-inset and the data-keyboard mark. The fixture's state is the tight one: a step whose
// confirm card is docked above the box. Measured before the fix (2026-11-13): the bar of final actions stayed at the foot and the
// box was cut off below it.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__phone_keyboard_fixture__.js', import.meta.url));
const fixture = { draftId: 'draft', projectId: 'project', roundId: 'round', sessionId: 'session',
  snapshot: { state: 'draft', workflow: { steps: [{ id: 's', title: '了解你' }] },
    steps: { s: { version: 1, reviewVersion: 0, valid: false } } },
  information: { s: { schema: [{ id: 'a', title: '目标' }, { id: 'b', title: '建议' }], values: {
    a: { value: '中文已确认\n第二行', status: 'confirmed', nature: 'hypothesis' },
    b: { value: '未确认建议', status: 'provisional', nature: 'decision' },
  }, meta: { a: { suggestion: { value: '未采用建议' } } } } } };

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const component = fileURLToPath(new URL('./InformationExport.tsx', import.meta.url));
  const positioning = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'export-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link' ||
          id.endsWith('/components/opc/workspace-frame')) return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}}); export const useParams=()=>({draftId:'draft'});
          export const usePathname=()=>'/app/positioning/draft'; export const useSearchParams=()=>new URLSearchParams();`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/components/opc/workspace-frame')) return `import React from 'react';
          const shell={height:'calc(100dvh - var(--keyboard-inset, 0px))',display:'flex',flexDirection:'column',overflow:'hidden',background:'#fff'};
          const row={height:48,boxSizing:'border-box',flex:'none',borderBottom:'1px solid #f0f0f0',padding:'12px 10px'};
          export function WorkspaceFrame(p){return React.createElement('div',{style:shell},
            React.createElement('div',{style:row},'‹ 对话'),p.children)}`;
        if (id.endsWith('/lib/supabase')) return `let actor='synthetic-user'; const listeners=new Set();
          window.switchActor=id=>{actor=id;for(const cb of listeners)cb('SIGNED_IN',id?{user:{id}}:null)};
          export const createClient=()=>({auth:{getSession:async()=>({data:{session:actor?{user:{id:actor}}:null},error:null}),
          onAuthStateChange:cb=>{listeners.add(cb);cb('INITIAL_SESSION',{user:{id:actor}});
          return {data:{subscription:{unsubscribe:()=>listeners.delete(cb)}}}}}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import {InformationExport} from ${JSON.stringify(component)};
          import PositioningDraft from ${JSON.stringify(positioning)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://export.test/api/trpc'})]});
          const root=createRoot(document.getElementById('root')); let data=${JSON.stringify(fixture)};
          window.renderExport=(next=data)=>{data=next;root.render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement('main',null,
            React.createElement('h1',null,'我的定位分析'),
            React.createElement('textarea',{defaultValue:'本机未保存输入', 'aria-label':'未保存输入'}),
            React.createElement(InformationExport,{draftId:data.draftId,current:data})))))};
          window.renderPositioning=()=>root.render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(React.Suspense,{fallback:'加载'},
              React.createElement(PositioningDraft,{params:Promise.resolve({draftId:'draft'})})))));
          window.unmountExport=()=>root.unmount(); window.renderExport();`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'InformationExportTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  css = output.filter((item: { fileName: string }) => item.fileName.endsWith('.css'))
    .map((item: { source: string }) => item.source).join('\n');
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);


const KEYBOARD = 300;
async function open(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = { ...structuredClone(fixture), mode: 'manual', plans: [], turns: [], runtimeMode: 'isolated' };
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div>' });
    const result = path.endsWith('/opc.read') ? data : path.endsWith('/runtime.view') ? { executions: [] }
      : path.endsWith('/opc.businesses') ? [] : path.endsWith('/opc.list') ? { drafts: [] } : path.endsWith('/opc.library') ? { businesses: [] }
        : path.endsWith('/opc.capturePending') ? { processed: [] } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
  });
  await page.goto('http://export.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await page.evaluate(() => (window as unknown as { renderPositioning: () => void }).renderPositioning());
  await page.getByRole('textbox', { name: '给 AI 教练的回复' }).waitFor();
  return { page, errors };
}
const keyboard = (page: import('@playwright/test').Page, inset: number) => page.evaluate(value => {
  document.documentElement.style.setProperty('--keyboard-inset', value + 'px');
  document.documentElement.toggleAttribute('data-keyboard', value > 0);
}, inset);

it('390x780, no keyboard: the page fits the screen, with the message box and the bar of final actions both on it', async () => {
  const { page, errors } = await open(390, 780);
  try {
    const box = await page.getByRole('textbox', { name: '给 AI 教练的回复' }).boundingBox();
    const confirm = await page.getByRole('button', { name: '确认正式定位' }).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(confirm!.y);
    expect(confirm!.y + confirm!.height).toBeLessThanOrEqual(780);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

for (const [width, height] of [[390, 780], [390, 664], [360, 640]]) {
  it(`${width}x${height} with a ${KEYBOARD}px keyboard: the box being typed in is whole and above the keyboard; the final actions step aside`, async () => {
    const { page, errors } = await open(width, height);
    try {
      await keyboard(page, KEYBOARD);
      const input = page.getByRole('textbox', { name: '给 AI 教练的回复' });
      await input.focus();
      const box = await input.boundingBox();
      const send = await page.getByRole('button', { name: '发送' }).boundingBox();
      expect(box!.y, 'under the top row').toBeGreaterThanOrEqual(48);
      expect(box!.y + box!.height, 'above the keyboard').toBeLessThanOrEqual(height - KEYBOARD);
      expect(send!.y + send!.height, 'the send button too').toBeLessThanOrEqual(height - KEYBOARD);
      await ui(page.getByRole('button', { name: '确认正式定位' })).toBeHidden();
      // The keyboard goes: the final actions are back.
      await keyboard(page, 0);
      await ui(page.getByRole('button', { name: '确认正式定位' })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}
