/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import tailwind from '@tailwindcss/postcss';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The search page on a phone (Owner 2026-11-12, mobile plan A, MOBILE-UX), in the workbench's center panel with the app's own
// styles, against simulated tRPC answers; no request leaves the browser. The frame itself is replaced by its panel (the
// shell is another task's): what is checked is the page. A computer keeps its layout (the last test).
let browser: Browser;
let code: string;
let css: string;
const src = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = fileURLToPath(new URL('./__search_phone_fixture__.js', import.meta.url));
const frameStub = '\0search-phone-frame';
const SHOTS = process.env.SEARCH_SHOTS;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const items = Array.from({ length: 14 }, (_, i) => ({ workItemId: uuid(100 + i), sessionId: uuid(200 + i),
  title: `一个比较长的工作标题，用来确认它在手机上不会把页面撑宽 ${i + 1}`, brief: null, archived: i === 1, uiRevision: 1 }));
const ANSWERS: Record<string, unknown> = {
  'opc.library': { businesses: [{ businessId: uuid(1), name: '测试品牌', accounts: [
    { projectId: uuid(2), platform: 'xiaohongshu', account: 'demo_account', displayName: '示例账号', strategyDraftId: uuid(3), items }] }] },
  'opc.list': { drafts: [{ draftId: uuid(3), businessName: '测试品牌', state: 'published' }] },
  'modules.getModules': { modules: [{ id: 'm1', title: '选题助手', description: '帮你想下周发什么', required_member_level: null }],
    hasMore: false },
  'user.getUserProfile': { id: uuid(9) },
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'search-phone-fixture', enforce: 'pre',
      resolveId(id: string) {
        if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link') return id;
        // The alias has already turned '@/…' into a path here.
        if (/\/components\/opc\/workspace-frame(\.tsx)?$/.test(id)) return frameStub;
      },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const useSearchParams=()=>new URLSearchParams(location.search); export const usePathname=()=>'/app/workbench/search';`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:null},error:null}),
          onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}});`;
        // The frame's panel only (the real CSS of the center panel, which clips; the page scrolls itself).
        if (id === frameStub) return `import React from 'react'; import frame from ${JSON.stringify(src + 'components/opc/workspace-frame.module.css')};
          export function WorkspaceFrame({children}){const h=React.createElement;return h('div',{className:frame.workspace},
            h('div',{className:frame.shell+' '+frame.noNotice},h('aside',{className:frame.rail}),h('section',{className:frame.center},children)));}`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(src + 'trpc/client.ts')};
          import ${JSON.stringify(src + 'app/globals.css')};
          import Search from ${JSON.stringify(fileURLToPath(new URL('./page.tsx', import.meta.url)))};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://search-phone.test/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(Search))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'SearchPhoneTest', formats: ['iife'] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; fileName: string;
    code?: string; source?: string | Uint8Array }>;
  code = output.find(item => item.type === 'chunk')!.code!;
  css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n');
  browser = await chromium.launch({ headless: true });
}, 90000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/trpc/')) {
      return route.fulfill({ contentType: 'text/html', body: '<html data-first-paint="light"><body style="margin:0">'
        + '<span data-first-paint="light" hidden></span><div id="root"></div></body></html>' });
    }
    const data = ANSWERS[url.pathname.replace('/api/trpc/', '')] ?? {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
  });
  await page.goto('http://search-phone.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('heading', { name: '搜索', exact: true })).toBeVisible({ timeout: 10000 });
  await ui(page.getByText('选题助手')).toBeVisible({ timeout: 10000 });
  return { page, errors };
}

for (const [width, height] of [[390, 844], [360, 740]] as const) {
  it(`on a ${width}px phone the box stays on top while results scroll, rows are thumb-sized, platforms are in Chinese`, async () => {
    const { page, errors } = await open(width, height);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const box = page.getByRole('searchbox', { name: '搜索工作或功能' });
      expect(await box.evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
      expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Every result row is at least 56px tall and as wide as the list; 恢复 is a 40px button.
      const rows = await page.locator('main a[href^="/app/runtime"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      expect(rows.length).toBe(14);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(56);
      expect((await page.getByRole('button', { name: '恢复' }).boundingBox())!.height).toBeGreaterThanOrEqual(40);
      // The platform reads 小红书, never its code.
      await ui(page.getByText('小红书 · 示例账号').first()).toBeVisible();
      expect(await page.locator('main').innerText()).not.toContain('xiaohongshu');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/search-${width}.png` });
      // Scrolled down the results, the box is still at the top of the panel.
      await page.locator('main').evaluate(node => { node.scrollTop = 900; });
      await page.waitForTimeout(100);
      const panelTop = await page.locator('main').evaluate(node => node.getBoundingClientRect().top);
      const boxTop = (await box.boundingBox())!.y;
      expect(boxTop).toBeGreaterThanOrEqual(panelTop - 1);
      expect(boxTop).toBeLessThan(panelTop + 24);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/search-${width}-scrolled.png` });
      // The Chinese name the rows show finds them too, as the code does (before, 小红书 found nothing).
      await box.fill('小红书');
      await ui(page.locator('main a[href^="/app/runtime"]')).toHaveCount(14);
      await box.fill('xiaohongshu');
      await ui(page.locator('main a[href^="/app/runtime"]')).toHaveCount(14);
      // Typing still filters as before.
      await box.fill('选题');
      await ui(page.getByText('没有匹配的工作。')).toBeVisible();
      await ui(page.getByText('选题助手')).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 45000);
}

it('a computer keeps its layout: the box is not pinned, keeps its label and its square look', async () => {
  const { page, errors } = await open(1280, 800);
  try {
    const box = page.getByRole('searchbox', { name: '搜索工作或功能' });
    const look = await box.evaluate(node => ({ position: getComputedStyle(node).position, radius: getComputedStyle(node).borderTopLeftRadius,
      background: getComputedStyle(node).backgroundColor }));
    expect(look).toEqual({ position: 'static', radius: '8px', background: 'rgb(255, 255, 255)' });
    await ui(page.getByText('搜索工作或功能', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 45000);
