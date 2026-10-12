/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The real positioning page against an opc.read answer shaped like staging's (R5, #811 acceptance steps 1, 2, 4).
let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__report_publish_fixture__.js', import.meta.url));
const read = (state: 'draft' | 'published', reportGeneration: boolean) => ({
  draftId: 'draft', projectId: 'project', roundId: 'round', sessionId: 'session', mode: 'manual', plans: [], turns: [],
  runtimeMode: 'isolated', report: state === 'published' ? { available: true, version: 1 } : undefined,
  snapshot: { state, currentVersion: state === 'published' ? 1 : 0,
    workflow: { id: 'w', version: 8, kind: 'document', reportGeneration, steps: [{ id: 's', title: '了解你' }] },
    steps: { s: { version: 1, reviewVersion: 0, valid: true } } },
  information: { s: { schema: [{ id: 'a', title: '目标', required: true }],
    values: { a: { value: '已确认目标', status: 'confirmed', nature: 'decision' } } } },
});

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const positioning = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'report-publish-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link' ||
          id.endsWith('/components/opc/workspace-frame')) return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const usePathname=()=>'/positioning/draft'; export const useSearchParams=()=>new URLSearchParams();`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/components/opc/workspace-frame')) return `import React from 'react';
          export function WorkspaceFrame(p){return React.createElement('div',null,p.children,p.right)}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:{user:{id:'synthetic-user'}}},error:null}),
          onAuthStateChange:cb=>{cb('INITIAL_SESSION',{user:{id:'synthetic-user'}});return {data:{subscription:{unsubscribe(){}}}}}}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import PositioningDraft from ${JSON.stringify(positioning)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://report.test/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(React.Suspense,{fallback:'加载'},
              React.createElement(PositioningDraft,{params:Promise.resolve({draftId:'draft'})})))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReportPublishTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

for (const state of ['draft', 'published'] as const) for (const reportGeneration of [true, false]) {
  it(`${reportGeneration ? 'hides' : 'keeps'} the old 「确认正式定位」 for a ${state} ${reportGeneration ? 'report' : 'legacy'} flow`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        const result = path.endsWith('/opc.read') ? read(state, reportGeneration) : path.endsWith('/runtime.view') ? { executions: [] }
          : path.endsWith('/opc.list') ? { drafts: [] } : path.endsWith('/opc.library') ? { businesses: [] }
            : path.endsWith('/opc.capturePending') ? { processed: [] } : path.endsWith('/runtime.reportAvailable') ? { enabled: true } : {};
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result } }) });
      });
      await page.goto('http://report.test/');
      await page.addScriptTag({ content: code });
      const footer = page.getByText(reportGeneration ? '所有步骤确认后生成完整报告' : '确认后保存为正式定位；生成选题将在下一步单独确认。');
      await ui(footer).toBeVisible({ timeout: 5000 });
      await page.waitForLoadState('networkidle');
      expect(await page.getByRole('button', { name: '确认正式定位' }).count()).toBe(reportGeneration ? 0 : 1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
}
