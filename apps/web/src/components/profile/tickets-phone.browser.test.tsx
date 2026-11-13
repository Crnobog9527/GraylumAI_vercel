/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import tailwind from '@tailwindcss/postcss';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The 在线反馈 / 工单 pages on a phone (Owner 2026-11-12, mobile plan A, MOBILE-UX): the list, one ticket and the new-ticket
// form, with the app's own styles, against simulated tRPC answers. Nothing is created, replied to or closed: every request
// that would write is answered with an error and counted, and the count must stay 0. A computer keeps its layout (last test).
let browser: Browser;
let code: string;
let css: string;
const src = fileURLToPath(new URL('../../', import.meta.url));
const entry = fileURLToPath(new URL('./__tickets_phone_fixture__.js', import.meta.url));
const SHOTS = process.env.TICKETS_SHOTS;
const ticket = (n: number, status: string, replies: unknown[] = []) => ({ id: `t${n}`, ticket_number: `TK-2026111${n}`,
  title: `示例工单 ${n}：一个比较长的标题，用来确认它在手机上不会把页面撑宽`, description: '这是问题描述。\n第二行。', category: 'technical_support',
  status, created_at: '2026-11-12T08:30:00Z', attachments: [], replies });
const TICKETS = [ticket(1, 'pending', [{ id: 'r1', message: '我们已经收到，正在处理。', is_admin_reply: true, attachments: [],
  created_at: '2026-11-12T09:00:00Z' }]), ticket(2, 'in_progress'), ticket(3, 'closed')];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const bundle = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'tickets-phone-fixture', enforce: 'pre',
      resolveId(id: string) { if (id === entry || id.endsWith('/lib/supabase')) return id; },
      load(id: string) {
        if (id.endsWith('/lib/supabase')) return `export const createClient=()=>({auth:{
          getSession:async()=>({data:{session:null},error:null}),
          onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}});`;
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${JSON.stringify(src + 'trpc/client.ts')};
          import ${JSON.stringify(src + 'app/globals.css')};
          import TicketsPanel from ${JSON.stringify(src + 'components/profile/TicketsPanel.tsx')};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
          const client=trpc.createClient({links:[httpLink({url:'http://tickets-phone.test/api/trpc'})]});
          const h=React.createElement;
          createRoot(document.getElementById('root')).render(h(trpc.Provider,{client,queryClient},
            h(QueryClientProvider,{client:queryClient},h('div',{style:{padding:'12px'}},h(TicketsPanel,{user:{}})))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'TicketsPhoneTest', formats: ['iife'] } },
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
  const writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'text/html', body: '<html data-first-paint="light"><body style="margin:0">'
        + '<span data-first-paint="light" hidden></span><div id="root"></div></body></html>' });
    }
    if (url.pathname === '/api/trpc/ticket.getTickets') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: TICKETS } }) });
    }
    writes.push(url.pathname);
    await route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'not in this test', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR' } } }) });
  });
  await page.goto('http://tickets-phone.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole('heading', { name: '我的工单' })).toBeVisible({ timeout: 10000 });
  await ui(page.getByTestId('ticket-list-item').first()).toBeVisible({ timeout: 10000 });
  return { page, errors, writes };
}

const height = (page: Page, name: string) => page.getByRole('button', { name }).first().evaluate(node => node.getBoundingClientRect().height);
const fontSize = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => getComputedStyle(node).fontSize);

for (const [width, tall] of [[390, 844], [360, 740]] as const) {
  it(`on a ${width}px phone the list, one ticket and the new-ticket form are thumb-sized and nothing is sent`, async () => {
    const { page, errors, writes } = await open(width, tall);
    try {
      const wide = () => page.evaluate(() => document.documentElement.scrollWidth);
      expect(await wide()).toBe(width);
      // The list: one switch the width of the card, 44px halves; rows at least 72px.
      const [active, closed] = await Promise.all([page.getByRole('button', { name: /现有工单/ }).boundingBox(),
        page.getByRole('button', { name: /已关闭/ }).boundingBox()]);
      expect(active!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(active!.width - closed!.width)).toBeLessThan(2);
      expect(active!.width).toBeGreaterThan((width - 80) / 2);
      const rows = await page.getByTestId('ticket-list-item').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(72);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tickets-${width}-list.png` });

      // One ticket: 关闭工单 as wide as the card, the reply box at 16px, 发送回复 48px.
      await page.getByTestId('ticket-list-item').first().click();
      await ui(page.getByTestId('ticket-detail-view')).toBeVisible();
      const close = await page.getByRole('button', { name: '关闭工单' }).boundingBox();
      expect(close!.height).toBeGreaterThanOrEqual(44);
      expect(close!.width).toBeGreaterThan(width - 80);
      expect(await fontSize(page, 'textarea')).toBe('16px');
      expect(await height(page, '发送回复')).toBeGreaterThanOrEqual(48);
      expect(await height(page, '返回工单列表')).toBeGreaterThanOrEqual(44);
      expect(await wide()).toBe(width);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tickets-${width}-detail.png`, fullPage: true });
      await page.getByRole('button', { name: '返回工单列表' }).click();

      // The form: 16px, 48px fields; 取消 and 提交工单 side by side, the main one wider, both 48px.
      await page.getByTestId('ticket-create-button').click();
      await ui(page.getByRole('heading', { name: '创建新工单' })).toBeVisible();
      expect(await fontSize(page, 'form input:not([type=file])')).toBe('16px');
      expect(await fontSize(page, 'form textarea')).toBe('16px');
      expect(await fontSize(page, 'form button[role=combobox]')).toBe('16px');
      expect(await page.locator('form input:not([type=file])').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
      const [cancel, submit] = await Promise.all([page.getByRole('button', { name: '取消' }).boundingBox(),
        page.getByRole('button', { name: '提交工单' }).boundingBox()]);
      expect(cancel!.height).toBeGreaterThanOrEqual(48);
      expect(submit!.height).toBeGreaterThanOrEqual(48);
      expect(submit!.width).toBeGreaterThan(cancel!.width * 1.5);
      expect(Math.abs(cancel!.y - submit!.y)).toBeLessThan(2);
      // The category list opens with 44px options.
      await page.locator('form button[role=combobox]').click();
      const option = await page.getByRole('option', { name: '功能建议' }).boundingBox();
      expect(option!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      expect(await wide()).toBe(width);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tickets-${width}-create.png`, fullPage: true });
      await page.getByRole('button', { name: '取消' }).click();
      await ui(page.getByRole('heading', { name: '我的工单' })).toBeVisible();
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 45000);
}

it('a computer keeps its layout: tabs side by side at their own width, 关闭工单 beside the title', async () => {
  const { page, errors, writes } = await open(1280, 800);
  try {
    const active = await page.getByRole('button', { name: /现有工单/ }).boundingBox();
    expect(active!.width).toBeLessThan(300);
    await page.getByTestId('ticket-list-item').first().click();
    const [title, close] = await Promise.all([page.getByRole('heading', { level: 2 }).boundingBox(),
      page.getByRole('button', { name: '关闭工单' }).boundingBox()]);
    expect(close!.x).toBeGreaterThan(title!.x + 200);
    expect(close!.width).toBeLessThan(200);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 45000);
