/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

const requestId = '00000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(43);
const credential = `${requestId}.${token}`;
const artifacts = process.env.ERASURE_UI_ARTIFACTS;
let browser: Browser;
let code = '', css = '';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__erasure_fixture__.tsx', import.meta.url));
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const transport = `async function call(path,input){const response=await fetch(path,{method:'POST',body:JSON.stringify(input)});
    const data=await response.json();if(!response.ok)throw data;return data;}
    const mutation=()=>({mutateAsync:input=>call('/confirm',input),reset:()=>{}});
    export const trpc={account:{erasurePreview:{useQuery:()=>({data:{credits:0,subscriptionRenewing:false,
      subscriptionActiveUntil:null,pendingPayments:0,runsInFlight:0,closed:false}})},erasureConfirm:{useMutation:mutation}},
      payments:{createCustomerPortalSession:{useMutation:()=>({mutateAsync:()=>{throw Error('forbidden portal')}})}}};
    export const createClient=()=>({auth:{signInWithPassword:async()=>({error:null}),
      signOut:()=>call('/signout',{})}});`;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env.NEXT_PUBLIC_HCAPTCHA_SITEKEY': JSON.stringify('synthetic') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@/trpc/client': '\0erasure-mocks', '@/lib/supabase': '\0erasure-mocks',
      '@/components/auth/DialogCaptcha': '\0erasure-captcha', '@': src } },
    plugins: [{ name: 'erasure-ui-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.startsWith('\0erasure-')) return id; },
      load(id: string) {
        if (id === '\0erasure-mocks') return transport;
        if (id === '\0erasure-captcha') return `import {useEffect} from 'react';
          export function DialogCaptcha({onToken}){useEffect(()=>{onToken('synthetic');},[onToken]);return null;}`;
        if (id !== entry) return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import '@/app/globals.css';
          import {AccountErasureCard} from '@/components/profile/AccountErasureCard';
          import {ErasureProgressPage} from '@/components/account-erasure/ErasureProgressPage';
          createRoot(document.getElementById('root')).render(location.pathname==='/profile'
            ? <AccountErasureCard user={{email:'synthetic@example.invalid'}}/> : <ErasureProgressPage/>);`;
      },
    }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ErasureUiTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  if (artifacts) mkdirSync(artifacts, { recursive: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

async function fixture(options: { width?: number; confirm?: 'missing' | 'unknown' | 'closed' | 'denied'; storageDenied?: boolean; signoutFails?: boolean } = {}) {
  const requests: { path: string; method: string; body: unknown; cookie?: string; authorization?: string }[] = [];
  let stage = 'closed', errorCode = '', hold = false;
  const pending: ServerResponse[] = [];
  const view = () => ({ stage, confirmedAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T01:00:00Z',
    needsReview: stage === 'billing_pending' });
  const respond = (response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json');
    if (errorCode) {
      response.statusCode = errorCode === 'NOT_FOUND' ? 404 : 429;
      response.end(JSON.stringify({ error: { message: 'raw must stay hidden', code: -32004,
        data: { code: errorCode, httpStatus: response.statusCode, path: 'account.erasureProgress' } } }));
    } else response.end(JSON.stringify({ result: { data: view() } }));
  };
  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/profile' || path === '/account-erasure') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>'
        + '<link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>'); return;
    }
    if (path === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(code); return; }
    if (path === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
    if (path === '/favicon.ico') { response.end(); return; }
    let input = '';
    for await (const chunk of request) input += chunk;
    requests.push({ path, method: request.method ?? '', body: input ? JSON.parse(input) : null,
      cookie: request.headers.cookie, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (path === '/confirm') {
      if (options.confirm === 'denied') { response.statusCode = 400;
        response.end(JSON.stringify({ message: 'ACCOUNT_ERASURE_REAUTH_REQUIRED', data: { code: 'BAD_REQUEST' } })); return; }
      if (options.confirm === 'unknown' || options.confirm === 'closed') {
        response.statusCode = 500;
        response.end(JSON.stringify(options.confirm === 'closed' ? { message: 'ACCOUNT_CLOSED' } : { message: 'lost response' }));
      } else response.end(JSON.stringify({ requestId, progressToken: options.confirm === 'missing' ? null : token }));
      return;
    }
    if (path === '/signout') { response.end(JSON.stringify({ error: options.signoutFails ? { message: 'synthetic failure' } : null })); return; }
    if (path === '/api/trpc/account.erasureProgress') {
      if (hold) pending.push(response); else respond(response);
      return;
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 1000 },
    serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const unexpected: string[] = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    unexpected.push(new URL(route.request().url()).origin); return route.abort();
  });
  if (options.storageDenied) await context.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get: () => { throw new Error('denied'); } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const logs: string[] = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(error.message));
  return { page, context, requests, logs, unexpected, origin,
    setStage: (value: string) => { stage = value; }, setError: (value: string) => { errorCode = value; },
    hold: () => { hold = true; }, release: () => { hold = false; pending.splice(0).forEach(respond); },
    close: async () => { await context.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

async function confirm(page: Page, origin: string) {
  await page.goto(`${origin}/profile`);
  await page.getByRole('button', { name: '注销账号', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('synthetic-only');
  await page.getByRole('button', { name: '验证身份', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认注销', exact: true }).click();
}

it('offers copy/download before signout, restores after real reload and queries every stage by credential-only POST', async () => {
  const f = await fixture();
  try {
    await confirm(f.page, f.origin);
    await ui(f.page.getByLabel('查询凭证', { exact: true })).toHaveValue(credential);
    expect(f.requests.filter(r => r.path === '/signout')).toHaveLength(0);
    await f.page.getByRole('button', { name: '复制凭证', exact: true }).click();
    expect(await f.page.evaluate(() => navigator.clipboard.readText())).toBe(credential);
    const downloading = f.page.waitForEvent('download');
    await f.page.getByRole('button', { name: '保存凭证文件' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('graylum-erasure-credential.txt');
    expect(readFileSync((await download.path())!, 'utf8')).toBe(credential);
    await f.page.getByRole('button', { name: '退出登录并查看进度' }).click();
    await ui(f.page.getByRole('heading', { name: '注销进度', exact: true })).toBeVisible();
    await f.page.reload();
    await ui(f.page.getByLabel('粘贴查询凭证')).toHaveValue(credential);
    expect(f.requests.filter(r => r.path.includes('erasureProgress'))).toHaveLength(0);
    await f.context.addCookies([{ name: 'fake-auth', value: 'must-not-send', url: f.origin }]);
    for (const [stage, title] of [['closed', '账号已关闭'], ['erasing', '正在清理'],
      ['billing_pending', '等待账务处理'], ['completed', '注销流程已完成']]) {
      f.setStage(stage);
      await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
      await ui(f.page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      if (stage === 'billing_pending') await ui(f.page.getByText('需要人工核查，尚不能确认全部处理完毕。')).toBeVisible();
    }
    const queries = f.requests.filter(r => r.path.includes('erasureProgress'));
    expect(queries).toHaveLength(4);
    for (const request of queries) expect(request).toEqual({ path: '/api/trpc/account.erasureProgress', method: 'POST',
      body: { requestId, token }, cookie: undefined, authorization: undefined });
    expect(f.requests.filter(r => r.path === '/confirm')).toHaveLength(1);
    expect(f.requests.filter(r => r.path === '/signout')).toHaveLength(1);
    expect(await f.page.evaluate(() => localStorage.length)).toBe(0);
    expect(f.page.url()).toBe(`${f.origin}/account-erasure`);
    expect(f.logs.join('\n')).not.toContain(token);
    expect(f.unexpected).toEqual([]);
    if (artifacts) await f.page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true, mask: [f.page.locator('textarea')] });
  } finally { await f.close(); }
}, 30000);

it('allows manual cross-session queries; clears stale results; refuses invalid/expired, rate-limited and offline queries without retries', async () => {
  const f = await fixture({ width: 390 });
  try {
    await f.page.goto(`${f.origin}/account-erasure`);
    await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
    await ui(f.page.getByRole('alert')).toContainText('请输入完整');
    expect(f.requests).toHaveLength(0);
    await f.page.getByLabel('粘贴查询凭证').fill(credential);
    f.hold();
    await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
    await ui(f.page.getByRole('button', { name: '查询中…' })).toBeDisabled();
    await ui.poll(() => f.requests.length).toBe(1);
    await f.page.getByRole('button', { name: '清除本机会话凭证' }).click();
    f.release();
    await ui(f.page.getByRole('button', { name: '查询进度', exact: true })).toBeEnabled();
    await ui(f.page.getByRole('heading', { name: '账号已关闭', exact: true })).toHaveCount(0);
    await f.page.reload();
    await ui(f.page.getByLabel('粘贴查询凭证')).toHaveValue('');
    await f.page.getByLabel('粘贴查询凭证').fill(credential);
    for (const [code, message] of [['NOT_FOUND', '凭证无效或已过期'], ['TOO_MANY_REQUESTS', '查询过于频繁']]) {
      f.setError(code);
      await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
      await ui(f.page.getByRole('alert')).toContainText(message);
      await ui(f.page.getByText('raw must stay hidden')).toHaveCount(0);
    }
    await f.context.setOffline(true);
    await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
    await ui(f.page.getByRole('alert')).toContainText('暂时无法查询');
    expect(f.requests).toHaveLength(3);
    await f.context.setOffline(false);
    f.setError('');
    f.setStage('billing_pending');
    await f.page.getByRole('button', { name: '查询进度', exact: true }).click();
    await ui(f.page.getByRole('heading', { name: '等待账务处理' })).toBeVisible();
    expect(f.requests).toHaveLength(4);
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (artifacts) await f.page.screenshot({ path: `${artifacts}/mobile.png`, fullPage: true, mask: [f.page.locator('textarea')] });
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
}, 30000);

for (const mode of ['missing', 'unknown', 'closed'] as const) it(`does not re-confirm or reissue on ${mode} capability outcome`, async () => {
  const f = await fixture({ confirm: mode });
  try {
    await confirm(f.page, f.origin);
    await ui(f.page.getByText(mode === 'unknown'
      ? '未收到注销确认结果，账号可能已关闭，当前无法查询进度。请勿再次申请注销。'
      : '账号已关闭，当前无法查询进度。', { exact: true })).toBeVisible();
    await ui(f.page.getByRole('button', { name: '确认注销', exact: true })).toHaveCount(0);
    await ui(f.page.getByRole('button', { name: '复制凭证', exact: true })).toHaveCount(0);
    await f.page.getByRole('button', { name: '退出登录并查看进度' }).click();
    await ui(f.page.getByRole('heading', { name: '注销进度', exact: true })).toBeVisible();
    await f.page.reload();
    await ui(f.page.getByText('当前无法查询进度。', { exact: false }).first()).toBeVisible();
    expect(f.requests.filter(r => r.path === '/confirm')).toHaveLength(1);
    expect(f.requests.filter(r => r.path.includes('erasureProgress'))).toHaveLength(0);
  } finally { await f.close(); }
}, 20000);

it('retains the returned credential on storage failure and offers manual copy on clipboard refusal', async () => {
  const f = await fixture({ storageDenied: true, width: 390 });
  try {
    await f.page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new Error('denied'); } },
    }));
    await confirm(f.page, f.origin);
    await ui(f.page.getByLabel('查询凭证', { exact: true })).toHaveValue(credential);
    await ui(f.page.getByRole('alert')).toContainText('无法保存会话副本');
    await f.page.getByRole('button', { name: '复制凭证', exact: true }).click();
    await ui(f.page.getByText('无法自动复制，请选中上方完整凭证手动复制。')).toBeVisible();
    expect(f.requests.filter(r => r.path === '/signout')).toHaveLength(0);
    expect(f.logs.join('\n')).not.toContain(token);
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
}, 20000);


it('keeps a definite pre-confirmation refusal on the confirmation screen without claiming closure', async () => {
  const f = await fixture({ confirm: 'denied' });
  try {
    await confirm(f.page, f.origin);
    await ui(f.page.getByRole('alert')).toContainText('重新验证');
    await ui(f.page.getByRole('button', { name: '确认注销', exact: true })).toBeVisible();
    expect(f.requests.filter(r => r.path === '/signout')).toHaveLength(0);
    expect(await f.page.evaluate(() => sessionStorage.getItem('graylum:erasure-progress'))).toBeNull();
  } finally { await f.close(); }
}, 20000);

it('keeps the credential available when local signout fails and never resubmits confirmation', async () => {
  const f = await fixture({ signoutFails: true });
  try {
    await confirm(f.page, f.origin);
    await ui(f.page.getByLabel('查询凭证', { exact: true })).toHaveValue(credential);
    await f.page.getByRole('button', { name: '退出登录并查看进度' }).click();
    await ui(f.page.getByRole('alert')).toContainText('未能退出本机登录');
    await ui(f.page.getByLabel('查询凭证', { exact: true })).toHaveValue(credential);
    expect(f.requests.filter(r => r.path === '/confirm')).toHaveLength(1);
    expect(f.page.url()).toBe(`${f.origin}/profile`);
  } finally { await f.close(); }
}, 20000);
