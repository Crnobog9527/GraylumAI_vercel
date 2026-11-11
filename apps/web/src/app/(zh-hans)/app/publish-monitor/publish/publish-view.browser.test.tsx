/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The layout of one-click publishing inside the workbench's center panel (its real CSS), against simulated tRPC answers;
// no request leaves the browser. The publishing flow itself is covered by page.browser.test.tsx. What only a rendered
// page can show: the page must scroll by itself (the center panel clips, see the data review page, 2026-11-11), the one
// primary action must stay in reach on a phone, and nothing may widen a 360px screen.
let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__publish_layout_fixture__.js', import.meta.url));
const file = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
const ITEM = '00000000-0000-4000-8000-000000000d01';
const BIZ = '00000000-0000-4000-8000-000000000d02';
const id = (n: number) => `00000000-0000-4000-8000-000000000d${n}`;
const connection = (connectionId: string, platform: string, consentPublish: boolean) => ({ id: connectionId, businessId: BIZ,
  accountProjectId: connectionId, role: 'own', source: 'postforme', platform, displayHint: null, status: 'connected',
  consentRead: true, consentAutoTrack: false, consentPublish, lastSuccessAt: null, postCount: 0 });
const ANSWERS: Record<string, unknown> = {
  'opc.library': { businesses: [{ businessId: BIZ, name: '测试品牌', accounts: [{ projectId: id(10), platform: 'x', items: [
    { workItemId: ITEM, title: '一个很长很长的选题标题用来确认它会换行而不是把页面撑宽', contentType: 'image_text',
      content: [{ kind: 'brief', version: 1, status: 'final', body: '定稿正文', contentAvailable: true }] }] }] }] },
  'publishMonitor.connections': [connection(id(10), 'x', true), connection(id(11), 'tiktok', true),
    connection(id(12), 'youtube', true), connection(id(13), 'instagram', false), connection(id(14), 'linkedin', false)],
  'publishMonitor.publish.options': { platforms: ['x', 'tiktok', 'youtube', 'instagram', 'linkedin'],
    holdCreditsByTargets: [6, 12, 18, 24, 30, 36, 42, 48, 54] },
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    // Only the CSS modules are needed; the app's PostCSS setup (Tailwind) is not loaded.
    css: { postcss: { plugins: [] } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'publish-layout-fixture', enforce: 'pre',
      resolveId(target: string) {
        if (target === entry || target.endsWith('/lib/supabase') || target === 'next/navigation' || target === 'next/link') return target;
      },
      load(target: string) {
        if (target === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const useSearchParams=()=>new URLSearchParams(location.search);`;
        if (target === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (target.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:{user:{id:'synthetic-user'}}},error:null}),
          onAuthStateChange:cb=>{cb('INITIAL_SESSION',{user:{id:'synthetic-user'}});return {data:{subscription:{unsubscribe(){}}}}}}});`;
        if (target !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${file('../../../../../trpc/client.ts')};
          import frame from ${file('../../../../../components/opc/workspace-frame.module.css')};
          import {PublishView} from ${file('./publish-view.tsx')};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://publish-layout.test/api/trpc'})]});
          const h=React.createElement;
          createRoot(document.getElementById('root')).render(h(trpc.Provider,{client,queryClient},
            h(QueryClientProvider,{client:queryClient},h('div',{className:frame.workspace},
              h('div',{className:frame.shell+' '+frame.noNotice},h('aside',{className:frame.rail}),
                h('section',{className:frame.center},h(PublishView)))))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'PublishLayoutTest', formats: ['iife'] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; fileName: string;
    code?: string; source?: string | Uint8Array }>;
  code = output.find(item => item.type === 'chunk')!.code!;
  css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  // Playwright's own headless Chromium, on a developer machine as in CI: it starts and closes in well under a second.
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/trpc/')) {
      return route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><div id="root"></div></body>' });
    }
    const data = ANSWERS[url.pathname.replace('/api/trpc/', '')] ?? {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
  });
  await page.goto(`http://publish-layout.test/?item=${ITEM}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('heading', { name: '一键发布' })).toBeVisible({ timeout: 10000 });
  await ui(page.getByRole('button', { name: '发布', exact: true })).toBeVisible({ timeout: 10000 });
  return { page, errors };
}

const captionTop = (page: Page) => page.getByRole('textbox').evaluate(node => Math.round(node.getBoundingClientRect().top));
const publishBox = (page: Page) => page.getByRole('button', { name: '发布', exact: true }).evaluate(node => {
  const box = node.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom };
});

it('scrolls inside the workbench panel: the caption below the fold can be reached with the wheel', async () => {
  const { page, errors } = await open(1280, 560);
  try {
    const before = await captionTop(page);
    expect(before).toBeGreaterThan(560);
    await page.mouse.move(600, 300);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => captionTop(page), { timeout: 3000 }).toBeLessThan(before - 200);
    // Accounts that can publish now are listed before the ones that still need authorizing.
    const names = await page.locator('li label').allTextContents();
    expect(names.slice(0, 3).sort()).toEqual(['TikTok', 'X', 'YouTube']);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('on a 360px phone nothing widens the page and the publish button stays in reach while the form scrolls', async () => {
  const { page, errors } = await open(360, 700);
  try {
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    expect(await width()).toBe(360);
    const first = await publishBox(page);
    expect(first.top).toBeGreaterThan(0);
    expect(first.bottom).toBeLessThanOrEqual(700);
    await page.mouse.move(180, 300);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
    const last = await publishBox(page);
    expect(last.bottom).toBeLessThanOrEqual(700);
    expect(last.top).toBeGreaterThan(0);
    await ui(page.getByRole('textbox')).toBeInViewport();
    expect(await width()).toBe(360);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
