/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The real publish page against simulated tRPC answers and a simulated upload host (no request leaves the browser).
// Served as https: file hashing (crypto.subtle) and attempt keys (crypto.randomUUID) need a secure context.
let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__publish_fixture__.js', import.meta.url));
const ITEM = '00000000-0000-4000-8000-000000000c01';
const BIZ = '00000000-0000-4000-8000-000000000c02';
const ACCOUNT_X = '00000000-0000-4000-8000-000000000c03';
const CONN_X = '00000000-0000-4000-8000-000000000c04';
const CONN_YT = '00000000-0000-4000-8000-000000000c05';
const CONN_TT = '00000000-0000-4000-8000-000000000c06';
const JOB = '00000000-0000-4000-8000-000000000c07';
const library = { businesses: [{ businessId: BIZ, name: '测试品牌', accounts: [{ projectId: ACCOUNT_X, platform: 'x', items: [
  { workItemId: ITEM, title: '选题一', contentType: 'image_text',
    content: [{ kind: 'brief', version: 2, status: 'final', body: '定稿正文', contentAvailable: true }] }] }] }] };
const connection = (id: string, platform: string, accountProjectId: string) => ({ id, businessId: BIZ, accountProjectId,
  role: 'own', source: 'postforme', platform, displayHint: null, status: 'connected', consentRead: true,
  consentAutoTrack: false, consentPublish: true, lastSuccessAt: null, postCount: 0 });
const job = (state: string, status: string) => ({ id: JOB, state, businessId: BIZ, workItemId: ITEM,
  targets: [{ connectionId: CONN_X, platform: 'x', status, url: status === 'published' ? 'https://x.com/i/1' : null }],
  holdCredits: 6, chargedCredits: state === 'completed' ? 6 : null, manualReview: false, errorCode: null,
  createdAt: 'now', updatedAt: 'now' });

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const pageFile = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const client = fileURLToPath(new URL('../../../../../trpc/client.ts', import.meta.url));
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../../', import.meta.url)) } },
    plugins: [{ name: 'publish-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase') || id === 'next/navigation' || id === 'next/link') return id; },
      load(id: string) {
        if (id === 'next/navigation') return `export const useRouter=()=>({replace:()=>{},push:()=>{}});
          export const useSearchParams=()=>new URLSearchParams('item=${ITEM}');`;
        if (id === 'next/link') return `import React from 'react'; export default function Link(p){return React.createElement('a',p)}`;
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:{user:{id:'synthetic-user'}}},error:null}),
          onAuthStateChange:cb=>{cb('INITIAL_SESSION',{user:{id:'synthetic-user'}});return {data:{subscription:{unsubscribe(){}}}}}}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(client)};
          import Page from ${JSON.stringify(pageFile)};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'https://publish.test/api/trpc'})]});
          createRoot(document.getElementById('root')).render(React.createElement(trpc.Provider,{client,queryClient},
            React.createElement(QueryClientProvider,{client:queryClient},React.createElement(Page))));`;
      } }],
    build: { write: false, minify: false, lib: { entry, name: 'PublishTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
// Closing Chrome after the https-served pages takes about 10 seconds on this machine; the browser work itself is done.
afterAll(async () => { await browser?.close(); }, 30000);

type Call = { path: string; input: unknown };
type Answer = { data?: unknown; error?: { code: string; message: string; status: number } };

async function open(answer: (path: string, input: unknown, calls: Call[]) => Answer | undefined) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const calls: Call[] = [];
  const uploads: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.host === 'upload.test') {
      uploads.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 200, body: '' });
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const path = url.pathname.replace('/api/trpc/', '');
    const raw = request.method() === 'GET' ? url.searchParams.get('input') : request.postData();
    const input = raw ? JSON.parse(raw) : undefined;
    calls.push({ path, input });
    const fixed: Record<string, unknown> = {
      'opc.library': library,
      'publishMonitor.connections': [connection(CONN_X, 'x', ACCOUNT_X), connection(CONN_YT, 'youtube', CONN_YT),
        { ...connection(CONN_TT, 'tiktok', CONN_TT), consentPublish: false }],
      'publishMonitor.publish.options': { platforms: ['x', 'tiktok'], holdCreditsByTargets: [6, 12, 18, 24, 30, 36, 42, 48, 54] },
    };
    const result = answer(path, input, calls) ?? { data: fixed[path] ?? {} };
    if (result.error) {
      return route.fulfill({ status: result.error.status, contentType: 'application/json', body: JSON.stringify({ error: {
        message: result.error.message, code: -32603, data: { code: result.error.code, httpStatus: result.error.status } } }) });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: result.data } }) });
  });
  await page.goto('https://publish.test/');
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('heading', { name: '一键发布' })).toBeVisible({ timeout: 5000 });
  return { page, calls, uploads, errors };
}

async function pickImageAndConfirm(page: Page) {
  await page.getByLabel('选择要发布的图片或视频').setInputFiles({ name: 'a.png', mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await page.getByRole('button', { name: '发布', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认发布' });
  await ui(dialog).toContainText('公开链接');
  await ui(dialog.getByRole('button', { name: '确认发布' })).toBeDisabled();
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: '确认发布' }).click();
}

const slot = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ uploadUrl: `https://upload.test/slot${i}`,
  mediaUrl: `https://media.test/m${i}.png` })) });
const count = (calls: Call[], path: string) => calls.filter(c => c.path === path).length;

it('lists only open platforms, uploads nothing before the confirmed disclosure, then publishes once', async () => {
  const { page, calls, uploads, errors } = await open(path => path === 'publishMonitor.publish.uploadUrl' ? slot(1)
    : path === 'publishMonitor.publish.submit' ? { data: job('unknown', 'pending') }
      : path === 'publishMonitor.publish.job' ? { data: job('completed', 'published') } : undefined);
  try {
    await ui(page.getByRole('checkbox', { name: 'X' })).toBeChecked();
    expect(await page.getByText('YouTube').count()).toBe(0);
    await ui(page.getByRole('button', { name: '授权发布' })).toBeVisible();
    await ui(page.getByRole('textbox')).toHaveValue('定稿正文');
    await ui(page.getByText('最多 6 积分')).toBeVisible();
    await page.getByLabel('选择要发布的图片或视频').setInputFiles({ name: 'a.png', mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await page.getByRole('button', { name: '发布', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    expect(count(calls, 'publishMonitor.publish.uploadUrl')).toBe(0);
    expect(uploads).toEqual([]);
    await page.getByRole('button', { name: '发布', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认发布' });
    await dialog.getByRole('checkbox').click();
    await dialog.getByRole('button', { name: '确认发布' }).click();
    await ui(page.getByRole('link', { name: '查看帖子' })).toBeVisible();
    await ui(page.getByText('本次扣除 6 积分')).toBeVisible();
    expect(uploads).toEqual(['PUT /slot0']);
    const upload = calls.find(c => c.path === 'publishMonitor.publish.uploadUrl')!.input;
    expect(upload).toEqual({ disclosureAccepted: true, count: 1, connectionIds: [CONN_X] });
    const submit = calls.find(c => c.path === 'publishMonitor.publish.submit')!.input as Record<string, unknown>;
    expect(submit).toMatchObject({ businessId: BIZ, workItemId: ITEM, connectionIds: [CONN_X], caption: '定稿正文',
      media: [{ mediaUrl: 'https://media.test/m0.png', mimeType: 'image/png', size: 8 }] });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a lost submit answer is retried with the same key and the same upload; a failed job uploads again', async () => {
  let submits = 0;
  const { page, calls, uploads } = await open(path => {
    if (path === 'publishMonitor.publish.uploadUrl') return slot(1);
    if (path === 'publishMonitor.publish.submit') {
      submits += 1;
      return submits === 1 ? { error: { code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_UNAVAILABLE', status: 500 } }
        : { data: job('failed', 'failed') };
    }
    if (path === 'publishMonitor.publish.job') return { data: job('failed', 'failed') };
  });
  try {
    await pickImageAndConfirm(page);
    const again = page.getByRole('button', { name: '再试一次（同一次发布，不会重复发）' });
    await ui(again).toBeVisible();
    await again.click();
    const dialog = page.getByRole('dialog', { name: '确认发布' });
    await dialog.getByRole('checkbox').click();
    await dialog.getByRole('button', { name: '确认发布' }).click();
    await ui(page.getByText('积分已全部退回')).toBeVisible();
    const keys = calls.filter(c => c.path === 'publishMonitor.publish.submit').map(c => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // Every retry uploads the file again (an old media link is never reused), under the same key.
    expect(uploads).toHaveLength(2);
    // After a final failure, a new attempt uploads again under a new key.
    await page.getByRole('button', { name: '重新发布（会重新上传素材）' }).click();
    await pickImageAndConfirm(page);
    await ui(page.getByText('积分已全部退回')).toBeVisible();
    const third = calls.filter(c => c.path === 'publishMonitor.publish.submit').at(-1)!.input as { idempotencyKey: string };
    expect(third.idempotencyKey).not.toBe(keys[0]);
    expect(uploads).toHaveLength(3);
  } finally { await page.close(); }
}, 30000);

it('a full publishing channel tells the user it is busy and that nothing was charged', async () => {
  const { page } = await open(path => path === 'publishMonitor.publish.uploadUrl' ? slot(1)
    : path === 'publishMonitor.publish.submit'
      ? { error: { code: 'PRECONDITION_FAILED', message: 'PUBLISH_MONITOR_QUOTA_EXHAUSTED', status: 412 } } : undefined);
  try {
    await pickImageAndConfirm(page);
    await ui(page.getByRole('alert')).toContainText('发布通道暂时繁忙');
    await ui(page.getByRole('button', { name: '发布', exact: true })).toBeVisible();
  } finally { await page.close(); }
}, 30000);

it('after a reload, an unconfirmed submit is replayed with the same key and the same file, and nothing else can change', async () => {
  let submits = 0;
  const { page, calls, uploads } = await open(path => {
    if (path === 'publishMonitor.publish.uploadUrl') return slot(1);
    if (path === 'publishMonitor.publish.submit') {
      submits += 1;
      return submits === 1 ? { error: { code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_UNAVAILABLE', status: 500 } }
        : { data: job('unknown', 'pending') };
    }
    if (path === 'publishMonitor.publish.job') return { data: job('unknown', 'pending') };
  });
  const file = { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') };
  try {
    await pickImageAndConfirm(page);
    await ui(page.getByRole('button', { name: '再试一次（同一次发布，不会重复发）' })).toBeVisible();
    // The tab reloads before the user retries: memory is gone, storage keeps only the key and the file identity.
    await page.goto('https://publish.test/');
    await page.addScriptTag({ content: code });
    await ui(page.getByText('上一次提交还没有确认结果')).toBeVisible();
    await ui(page.getByRole('textbox')).toBeDisabled();
    await ui(page.getByRole('checkbox', { name: 'X' })).toBeDisabled();
    await page.getByLabel('选择要发布的图片或视频').setInputFiles({ ...file, buffer: Buffer.from('ffd8ffe000104a46', 'hex') });
    await page.getByRole('button', { name: '再试一次（同一次发布，不会重复发）' }).click();
    await page.getByRole('dialog').getByRole('checkbox').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认发布' }).click();
    await ui(page.getByRole('alert')).toContainText('同样的文件');
    expect(uploads).toHaveLength(1);
    await page.getByRole('button', { name: /移除/ }).click();
    await page.getByLabel('选择要发布的图片或视频').setInputFiles(file);
    await page.getByRole('button', { name: '再试一次（同一次发布，不会重复发）' }).click();
    await page.getByRole('dialog').getByRole('checkbox').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认发布' }).click();
    await ui(page.getByText('已提交，正在等平台结果')).toBeVisible();
    const keys = calls.filter(c => c.path === 'publishMonitor.publish.submit').map(c => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(uploads).toHaveLength(2);
  } finally { await page.close(); }
}, 30000);
