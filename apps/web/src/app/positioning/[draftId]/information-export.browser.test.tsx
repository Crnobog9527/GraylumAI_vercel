/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__information_export_fixture__.js', import.meta.url));
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
  const client = fileURLToPath(new URL('../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'export-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link' ||
          id.endsWith('/components/opc/workspace-frame')) return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const usePathname=()=>'/positioning/draft'; export const useSearchParams=()=>new URLSearchParams();`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/components/opc/workspace-frame')) return `import React from 'react';
          export function WorkspaceFrame(p){return React.createElement('div',null,p.children,p.right)}`;
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
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

for (const membership of ['free', 'expired']) it(`downloads via only a fresh opc.read for ${membership} users`, async () => {
  const page = await browser.newPage();
  const requests: string[] = [];
  try {
    await page.route('**/*', async route => {
      requests.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: { ...fixture, membership } } }) });
    });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已确认资料' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('已确认的前置信息.md');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('中文已确认\n> 第二行');
    expect(text).toContain('性质：假设');
    expect(text).not.toMatch(/未保存|未确认建议|未采用|session|project|membership/);
    expect(requests).toEqual(['GET /api/trpc/opc.read']);
    await ui(page.getByRole('status')).toHaveText('已下载已确认资料。');
  } finally { await page.close(); }
});

for (const scenario of ['failure', 'version', 'identity', 'actor', 'actor-roundtrip', 'unmount', 'empty', 'visible-version']) {
  it(`does not download stale information after ${scenario}`, async () => {
    const page = await browser.newPage();
    const downloads: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const received = new Promise<void>(resolve => { requested = resolve; });
    page.on('download', item => downloads.push(item.suggestedFilename()));
    try {
      await page.route('**/*', async route => {
        requested(); await held;
        if (scenario === 'failure') return route.abort();
        const data = structuredClone(fixture);
        if (scenario === 'version') data.snapshot.steps.s.version++;
        if (scenario === 'identity') data.roundId = 'different';
        if (scenario === 'empty') data.information.s.values.a.status = 'provisional';
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
      });
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: code });
      if (scenario === 'empty') await page.evaluate(data => {
        data.information.s.values.a.status = 'provisional';
        (window as unknown as { renderExport: (data: unknown) => void }).renderExport(data);
      }, fixture);
      await page.getByRole('button', { name: '导出已确认资料' }).click();
      await received;
      await ui(page.getByRole('button')).toBeDisabled();
      if (scenario.startsWith('actor')) await page.evaluate(roundtrip => {
        const w = window as unknown as { switchActor: (id: string) => void };
        w.switchActor('different'); if (roundtrip) w.switchActor('synthetic-user');
      }, scenario === 'actor-roundtrip');
      if (scenario === 'unmount') await page.evaluate(() => (window as unknown as { unmountExport: () => void }).unmountExport());
      if (scenario === 'visible-version') await page.evaluate(data => {
        data.snapshot.steps.s.version++;
        (window as unknown as { renderExport: (data: unknown) => void }).renderExport(data);
      }, fixture);
      release();
      if (scenario !== 'unmount') await ui(page.getByRole('status')).toHaveText(scenario === 'empty'
        ? '还没有已确认的资料。确认后即可免费导出。' : scenario === 'failure'
          ? '暂时无法读取已确认资料，请稍后重试。' : '资料或登录状态已变化，请刷新页面后再导出。');
      else await page.waitForTimeout(100);
      expect(downloads).toEqual([]);
    } finally { release(); await page.close(); }
  });
}

for (const width of [390, 1920]) it(`downloads from the actual positioning page entry at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 963 } });
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = { ...structuredClone(fixture), mode: 'manual', plans: [], turns: [], runtimeMode: 'isolated' };
  try {
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      requests.push(route.request().method() + ' ' + path);
      const result = path.endsWith('/opc.read') ? data : path.endsWith('/runtime.view') ? { executions: [] }
        : path.endsWith('/opc.list') ? { drafts: [] } : path.endsWith('/opc.library') ? { businesses: [] }
          : path.endsWith('/opc.capturePending') ? { processed: [] } : {};
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
    });
    await page.goto('http://export.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => (window as unknown as { renderPositioning: () => void }).renderPositioning());
    await ui(page.getByRole('heading', { name: '录入已有定位', exact: true })).toBeVisible({ timeout: 3000 });
    await ui(page.getByRole('button', { name: '导出已确认资料' })).toBeVisible();
    await page.getByRole('textbox', { name: '给导师的回复' }).fill('未发送的本机输入');
    // Page initialization has its own existing reads/capture catch-up. Measure the export action separately.
    await page.waitForLoadState('networkidle');
    requests.length = 0;
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已确认资料' }).click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString('utf8');
    expect(content).toContain('中文已确认');
    expect(content).not.toContain('未发送的本机输入');
    const box = await page.getByRole('button', { name: '导出已确认资料' }).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (process.env.INFORMATION_EXPORT_SHOTS)
      await page.screenshot({ path: `${process.env.INFORMATION_EXPORT_SHOTS}/information-export-${width}.png` });
    expect(requests).toEqual(['GET /api/trpc/opc.read']);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);
