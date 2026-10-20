/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__profile_archive_fixture__.js', import.meta.url));
const profiles = () => [
  { businessId: 'b-1', name: '小红书 · 健身', archivedAt: null, isArchived: false },
  { businessId: 'b-2', name: '抖音 · 读书', archivedAt: null, isArchived: false },
  { businessId: 'b-3', name: '旧账号', archivedAt: '2026-10-19T00:00:00Z', isArchived: true },
];
const drafts = { drafts: [
  { draftId: '11111111-1111-4111-8111-111111111111', businessId: 'b-1', createdAt: '2026-10-01' },
  { draftId: '33333333-3333-4333-8333-333333333333', businessId: 'b-3', createdAt: '2026-10-02' },
] };

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const component = fileURLToPath(new URL('./ProfileArchiveList.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
    plugins: [{ name: 'profile-archive-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id === 'next/link') return id; },
      load(id: string) {
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import {ProfileArchiveList} from ${JSON.stringify(component)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://archive.test/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(ProfileArchiveList,{limitReached:true}))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'ProfileArchiveTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

/** Serves the three reads; `archive` answers the archive call and returns what the next profile read shows. */
async function open(page: Page, archive: (body: unknown) => { ok: boolean }) {
  const state = { rows: profiles(), archives: [] as unknown[] };
  await page.route('**/api/trpc/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').pop();
    const reply = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
    if (path === 'opc.businesses') return reply(state.rows);
    if (path === 'opc.list') return reply(drafts);
    if (path === 'user.getEntitlements') return reply({ positioningProfileLimit: 3 });
    if (path === 'opc.archiveBusiness') {
      const body = route.request().postDataJSON();
      state.archives.push(body);
      if (!archive(body).ok) return route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'INTERNAL', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR' } } }) });
      state.rows = state.rows.map(row => row.businessId === (body as { businessId: string }).businessId
        ? { ...row, isArchived: true, archivedAt: '2026-10-20T00:00:00Z' } : row);
      return reply(state.rows.find(row => row.businessId === (body as { businessId: string }).businessId));
    }
    return route.abort();
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: code });
  return state;
}

it('lists profiles with the allowance, archives one after confirming, and moves it to the read-only group', async () => {
  const page = await browser.newPage();
  try {
    const state = await open(page, () => ({ ok: true }));
    await ui(page.getByText('已用 2/3 个名额')).toBeVisible();
    await ui(page.getByText('名额用完了，可以把不再更新的档案归档。')).toBeVisible();
    await page.getByText('已归档（1）').click();
    await ui(page.getByRole('link', { name: '查看' })).toHaveAttribute('href', '/positioning/33333333-3333-4333-8333-333333333333');
    // Cancelling sends nothing.
    await page.getByRole('button', { name: '归档' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: '归档这个定位档案？' });
    await ui(dialog).toContainText('小红书 · 健身');
    await ui(dialog).toContainText('归档后只能查看和导出，不能再继续对话或生成报告。会释放 1 个名额，归档后不能恢复。');
    await dialog.getByRole('button', { name: '先不归档' }).click();
    await ui(dialog).toBeHidden();
    expect(state.archives).toEqual([]);
    await page.getByRole('button', { name: '归档' }).first().click();
    await page.getByRole('button', { name: '确认归档' }).click();
    await ui(page.getByRole('status')).toHaveText('已归档，空出了 1 个名额。');
    expect(state.archives).toEqual([{ businessId: 'b-1' }]);
    await ui(page.getByText('已用 1/3 个名额')).toBeVisible();
    await ui(page.getByText('已归档（2）')).toBeVisible();
    await ui(page.getByRole('button', { name: '归档' })).toHaveCount(1);
  } finally { await page.close(); }
}, 30000);

it('keeps the dialog open with a plain notice when archiving fails', async () => {
  const page = await browser.newPage();
  try {
    const state = await open(page, () => ({ ok: false }));
    await page.getByRole('button', { name: '归档' }).first().click();
    await page.getByRole('button', { name: '确认归档' }).click();
    await ui(page.getByRole('alertdialog').getByRole('alert')).toHaveText('归档没成功，请稍后再试。');
    expect(state.archives).toHaveLength(1);
    await ui(page.getByText('已用 2/3 个名额')).toBeVisible();
  } finally { await page.close(); }
}, 30000);
