/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import { chromium, expect as ui, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('compare stop billing in a real browser (synthetic, no paid calls)', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let script: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
    const { build } = await import(pathToFileURL(vitePath).href);
    const fixture = fileURLToPath(new URL('./__compare_charge_fixture__.js', import.meta.url));
    const card = fileURLToPath(new URL('./CompareCard.tsx', import.meta.url));
    const records = fileURLToPath(new URL('../profile/CreditRecordsCard.tsx', import.meta.url));
    const mock = `
      import { useQuery, useMutation } from '@tanstack/react-query';
      const s = window.__billing;
      const query = data => ({ data, isLoading: false, isError: false, refetch() {} });
      const invalidate = key => ({ invalidate: async () => {
        s.invalidations.push(key);
        await window.__qc.invalidateQueries({ queryKey: [key] });
      } });
      const utils = { credits: { getBalance: invalidate('balance'), getCreditTransactions: invalidate('records'),
        getCreditsSummary: invalidate('summary') }, client: { fusionCompare: { stream: { mutate: async function*() {} } } } };
      export const trpc = { useUtils: () => utils, fusionCompare: {
        read: { useQuery: (_input, options) => useQuery({ ...options, queryKey: ['compare'], queryFn: async () => {
          s.reads++;
          if (s.stopped && ++s.stopReads >= 2) { s.view = s.final; s.records = s.finalRecords; }
          return structuredClone(s.view);
        } }) },
        stop: { useMutation: options => { const m = useMutation({ ...options, mutationFn: async () => {
          s.stopped = true; s.view = s.pending;
        } }); return { ...m, isPending: m.isPending }; } },
        adopt: { useMutation: () => ({ isPending: false }) }
      }, credits: {
        getCreditsSummary: { useQuery: () => query({ totalSpent: 20 }) },
        getCreditTransactions: { useQuery: (_input, options) => useQuery({ ...options, retry: false,
          queryKey: ['records'], queryFn: async () => {
            if (s.recordsError) throw new Error('private detail');
            return { items: s.records, totalCount: s.records.length };
          } }) }
      } };
    `;
    const bundle = await build({ configFile: false, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      oxc: { jsx: { runtime: 'automatic' } },
      resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
      plugins: [{ name: 'compare-charge-fixture', enforce: 'pre', resolveId(id: string) {
        if (id === fixture) return id;
        if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0compare-trpc';
        if (id.includes('transaction-search-charges')) return '\0search';
        if (id.includes('MessageMarkdown')) return '\0markdown';
      }, load(id: string) {
        if (id === '\0compare-trpc') return mock;
        if (id === '\0search') return 'export const TransactionSearchCharges = () => null;';
        if (id === '\0markdown') return 'export const MessageMarkdown = ({text}) => text;';
        if (id === fixture) return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
          import {CompareCard} from ${JSON.stringify(card)}; import {CreditRecordsCard} from ${JSON.stringify(records)};
          const qc = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
          window.__qc = qc;
          createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:qc},
            window.__billing.recordsOnly ? React.createElement(CreditRecordsCard,{user:{credits:980}})
              : React.createElement(React.Fragment,null,
                React.createElement(CompareCard,{compareId:'compare',names:{m0:'Sonnet',m1:'GPT'},onAdopted(){},onQuote(){}}),
                React.createElement(CreditRecordsCard,{user:{credits:980}}))));`;
      } }], build: { write: false, minify: false, lib: { entry: fixture, name: 'CompareChargeTest', formats: ['iife'] } } });
    const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
    script = output.find((item: { type: string }) => item.type === 'chunk').code;
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><div id="root"></div>'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no local preview');
    origin = `http://127.0.0.1:${address.port}`;
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve())); });

  const column = (n: number, state: string, charged: number, verdict: string | null, body: string | null = null) => ({
    column: n, runId: `r${n}`, modelId: `m${n}`, body,
    billing: { state, closed: state !== 'dispatched', chargedCredits: charged, reservedCredits: n ? 64 : 38 },
    call: { callId: `c${n}`, state: 'responded', dispatched: true, settled: state === 'settled', verdict },
  });
  const rows = [0, 1].map(n => ({ id: `tx${n}`, type: 'consumption', amount: -10, ledger_type: 'spend',
    reason_code: 'bill2_spend', counts_as_spend: true, created_at: '2026-10-26T11:26:21Z' }));
  async function open(setup: Record<string, unknown>) {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('browser error', error.message));
    await page.goto(origin);
    await page.evaluate(s => { (window as unknown as { __billing: unknown }).__billing = s; }, {
      reads: 0, stopReads: 0, invalidations: [], records: rows, ...setup });
    await page.addScriptTag({ content: script });
    await page.waitForSelector('#root > *', { timeout: 2000 });
    return page;
  }

  it('stop keeps polling until the late charged column settles, then shows 10 + 10 = 20 and the actual spends', async () => {
    const finished = column(0, 'settled', 10, 'usable', '已保存的回答');
    const pending = { state: 'stopped', chargedCredits: 10, columns: [finished, column(1, 'cost_pending', 0, null)] };
    // Deliberately stale aggregate: the visible sum must come from the same snapshot as its columns.
    const final = { state: 'stopped', chargedCredits: 10, columns: [finished, column(1, 'settled', 10, 'user_stopped')] };
    const page = await open({ view: { state: 'running', columns: [finished, column(1, 'dispatched', 0, null)] }, pending, final, records: [], finalRecords: rows });
    try {
      await ui(page.getByText('共 0 条记录', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '全部停止', exact: true }).click();
      await ui(page.getByRole('article', { name: 'GPT', exact: true })).toContainText('暂时冻结 64 积分');
      await ui(page.getByText('本次对比共扣', { exact: false })).toHaveCount(0);
      await ui(page.getByText('已停止，不收费', { exact: true })).toHaveCount(0);
      await ui(page.getByText('本次对比共扣', { exact: false })).toContainText('20 积分', { timeout: 16_000 });
      await ui(page.getByRole('article', { name: 'GPT', exact: true })).toContainText('按已生成部分计费 10 积分');
      await ui(page.getByText('实际扣费 10 积分', { exact: true })).toHaveCount(2);
      await ui(page.getByText('-10 积分', { exact: true })).toHaveCount(2);
      await ui(page.getByText('共 2 条记录', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __billing: { invalidations: string[]; recordsError: boolean } }).__billing.invalidations.filter((key: string) => key === 'records').length)).toBe(2);
    } finally { await page.close(); }
  }, 30_000);

  it('a zero-usage stopped column says free with no spend in its records', async () => {
    const free = column(1, 'refunded', 0, null);
    free.call.dispatched = false;
    const page = await open({ view: { state: 'stopped', columns: [column(0, 'settled', 10, 'usable', '回答'), free] }, records: rows.slice(0, 1) });
    try {
      await ui(page.getByRole('article', { name: 'GPT', exact: true })).toContainText('已停止，不收费');
      await ui(page.getByText('本次对比共扣', { exact: false })).toContainText('10 积分');
      await ui(page.getByText('-10 积分', { exact: true })).toHaveCount(1);
    } finally { await page.close(); }
  });

  it('a failed ledger read never displays zero records; retry displays its real spends', async () => {
    const page = await open({ recordsOnly: true, recordsError: true });
    try {
      await ui(page.getByRole('alert')).toContainText('积分记录暂时无法读取');
      await ui(page.getByText('共 0 条记录', { exact: true })).toHaveCount(0);
      await ui(page.getByText('暂无交易记录', { exact: true })).toHaveCount(0);
      await page.evaluate(() => { (window as unknown as { __billing: { invalidations: string[]; recordsError: boolean } }).__billing.recordsError = false; });
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await ui(page.getByText('共 2 条记录', { exact: true })).toBeVisible();
    } finally { await page.close(); }
  });
});
