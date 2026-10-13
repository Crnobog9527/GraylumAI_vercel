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

// Everything around the list is stubbed; the erasure dialog stub records which target it was opened for.
const stubs: Array<[(id: string) => boolean, string]> = [
  [id => id.endsWith('/trpc/client'), `const q=data=>({data,error:null,isPending:false,isSuccess:true,refetch:async()=>{}});
    const m=()=>({isPending:false,mutate(){},mutateAsync:async()=>({})});
    export const trpc={useUtils:()=>new Proxy({},{get:()=>new Proxy({},{get:()=>()=>{}})}),
      opc:{library:{useQuery:()=>q({accounts:[]})},list:{useQuery:()=>q([])},
        conversations:{useQuery:()=>q([{sessionId:'${SESSION}',title:'周末选题讨论',lastActivityAt:'2026-10-13T00:00:00Z'}])},
        workUiChange:{useMutation:m},accountUiChange:{useMutation:m}},
      user:{getUserProfile:{useQuery:()=>q(null)}},ticket:{createTicket:{useMutation:m}}};`],
  [id => id.endsWith('/hooks/use-credits'), 'export const useCreditsBalance=()=>({data:undefined});'],
  [id => id.endsWith('/lib/supabase'), 'export const createClient=()=>({auth:{signOut:async()=>{}}});'],
  [id => id === 'next/navigation', `export const usePathname=()=>'/runtime';export const useRouter=()=>({push(){},replace(){}});`],
  [id => id === 'next/link', `import React from 'react';export default function Link(p){return React.createElement('a',p)}`],
  [id => id.endsWith('/strategy-overview-dialog'), 'export function StrategyOverviewDialog(){return null}'],
  [id => id.endsWith('/use-account-discussion'), 'export const useAccountDiscussion=()=>({opening:false,open(){}});'],
  [id => id.endsWith('/hooks/use-content-erasure'), 'export const useContentErasureSync=()=>{};'],
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
        window.opened=[];
        createRoot(document.getElementById('root')).render(React.createElement(WorkspaceFrame,null,'对话内容'));`;
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

async function open(width: number, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // A real origin, so the frame can use sessionStorage/localStorage; nothing leaves the test.
    await page.route('**/*', route => route.request().url() === 'http://frame.test/'
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
    await page.goto('http://frame.test/');
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

it('deletes a whole conversation from the list through ⋯ → 删除对话 → the existing dialog', () => open(1280, async page => {
  await ui(page.getByRole('button', { name: /永久删除对话/ })).toHaveCount(0);
  await more(page).focus();
  await ui(more(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await ui(more(page)).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: '删除对话' }).click();
  await ui(page.getByRole('dialog')).toHaveText('确认弹窗');
  expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened.at(-1)))
    .toEqual({ kind: 'session', id: SESSION });
  await ui(page.getByRole('menu')).toHaveCount(0);
}));

it('reaches the ⋯ button with Tab, which makes it visible', () => open(1280, async page => {
  for (let i = 0; i < 60 && !(await more(page).evaluate(el => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await ui(more(page)).toBeFocused();
  expect(await more(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');
}));
