/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The start page in a real browser when the server refuses a new positioning because the profile allowance is used
// (OPC_PROFILE_LIMIT, 走查 26). Both ways of asking for one (the one-click entry another page links to, and the dialog on this
// page) must end on the same ways out: go back to the positioning that exists, archive one, or see the plans. The real profile
// list is rendered; the server calls and the parts of the page that have nothing to do with it are replaced.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROFILE_ARCHIVE_TEXT } from '@/components/opc/profile-archive/profile-archive';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__start_limit_fixture__.js', import.meta.url));
const DRAFT = '11111111-1111-4111-8111-111111111111';
const STUBS: Record<string, string> = {
  'next/link': `import React from 'react'; export default function Link(props) { return React.createElement('a', props); }`,
  '@/lib/supabase': `export const createClient = () => ({ auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } });`,
  '@/trpc/client': `
    const read = data => ({ useQuery: () => ({ data, isSuccess: true, isPending: false, isLoading: false, error: null, refetch: async () => ({}) }) });
    window.starts = [];
    export const trpc = {
      runtime: { choices: read(undefined) },
      publishMonitor: { features: read(undefined) },
      user: { getEntitlements: read({ positioningProfileLimit: 1 }) },
      opc: {
        catalog: read([{ id: 'registration-1' }]),
        list: read({ drafts: [{ draftId: '${DRAFT}', createdAt: '2026-11-01', state: 'draft', currentVersion: 0 }] }),
        library: read({ businesses: [] }),
        businesses: read([{ businessId: 'b-1', name: '小红书 · 健身', archivedAt: null, isArchived: false, drafts: [{ draftId: '${DRAFT}' }] }]),
        archiveBusiness: { useMutation: () => ({ isPending: false, mutateAsync: async () => ({}) }) },
        // The allowance is used: every start is refused, as the server refuses it.
        start: { useMutation: () => ({ isPending: false, mutateAsync: async request => {
          window.starts.push(request); throw new Error('OPC_PROFILE_LIMIT');
        } }) },
      },
    };
  `,
  '@/components/opc/workspace-frame': `export const WorkspaceFrame = ({ children }) => children;`,
  '@/components/opc/work-composer': `export const WorkComposer = () => null;
    export const useFreeConversation = () => ({ send() {}, ensureSession: async () => '', busy: false, error: '', references: [], setReferences() {} });`,
  '@/components/fusion-compare/ComparePicker': `export const CompareButton = () => null;`,
};
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'start-limit-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      // The page's look is not what is under test: a CSS module answers each class with its own name.
      if (id.endsWith('.module.css')) return '\0css-module';
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id === '\0css-module') return `export default new Proxy({}, { get: (_, name) => String(name) });`;
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'StartLimitTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open(search: string) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A real origin: the page keeps its start request in sessionStorage. Nothing leaves the machine.
  await page.route('**/*', route => (route.request().url().startsWith('https://start.test/app/positioning')
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }) : route.abort()));
  await page.goto(`https://start.test/app/positioning${search}`);
  await page.addScriptTag({ content: code });
  return { page, errors };
}
/** The three ways out, wherever the refusal is shown. */
async function expectWaysOut(page: Page) {
  await browserExpect(page.getByRole('alert').filter({ hasText: PROFILE_ARCHIVE_TEXT.limitReached })).toBeVisible();
  await browserExpect(page.getByRole('link', { name: '继续已有的定位' })).toHaveAttribute('href', `/app/positioning/${DRAFT}`);
  await browserExpect(page.getByRole('button', { name: '归档' })).toBeVisible();
  await browserExpect(page.getByRole('link', { name: '查看会员方案 →' })).toHaveAttribute('href', '/pricing');
  await browserExpect(page.getByText('已用 1/1 个名额')).toBeVisible();
}

it('the one-click start that is refused says the allowance is used and shows the three ways out, not an endless "正在建立"', async () => {
  const { page, errors } = await open('?start=mentor&intent=22222222-2222-4222-8222-222222222222');
  try {
    await browserExpect(page.getByRole('heading', { name: '开始定位分析' })).toBeVisible();
    await expectWaysOut(page);
    await browserExpect(page.getByText('正在建立定位草稿…')).toHaveCount(0);
    await browserExpect(page.getByRole('link', { name: '返回对话入口' })).toBeVisible();
    // one start was asked for, with the entry's own id, and it is not kept to be resumed: there is nothing to resume
    expect(await page.evaluate('window.starts')).toEqual([expect.objectContaining({ requestId: '22222222-2222-4222-8222-222222222222', mode: 'mentor' })]);
    await browserExpect(page.getByRole('button', { name: '恢复上次开始请求' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a start from this page that is refused shows the same ways out', async () => {
  const { page, errors } = await open('');
  try {
    await page.getByRole('button', { name: '梳理账号定位' }).click();
    await page.getByRole('dialog', { name: '梳理账号定位' }).getByRole('button', { name: '我已有定位' }).click();
    await expectWaysOut(page);
    expect(await page.evaluate('window.starts')).toEqual([expect.objectContaining({ mode: 'manual' })]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
