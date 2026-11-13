/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Three small profile-center fixes found while validating #1869 on staging (2026-11-12), with the real cards, the app's
// Tailwind CSS and a stand-in for tRPC in a browser:
//  1. the change-password dialog kept the three typed passwords after it was closed;
//  2. on a 360px phone a credit record with a long description widened the page;
//  3. the nickname's save and cancel buttons were icons without a name.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__profile_small_fixes_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const LONG = '定位分析对话'.repeat(40);

const trpcMock = `
  const ok = data => ({ data, isError: false, isFetching: false, isLoading: false, refetch() {} });
  const record = (id, reason) => ({ id, type: 'spend', ledger_type: 'spend', counts_as_spend: true, amount: -36, balance_after: 22563, reason,
    created_at: '2026-11-10T08:12:00Z' });
  export const trpc = {
    useUtils: () => ({ user: { getUserProfile: { invalidate() {} } } }),
    user: { updateUserProfile: { useMutation: () => ({ mutateAsync: async input => input }) } },
    credits: {
      getCreditsSummary: { useQuery: () => ok({ totalSpent: 1284 }) },
      // window.__trend: spending on three of the last 14 days (300 today, 150 yesterday, 30 three days ago), for the trend chart.
      getCreditTransactions: { useQuery: () => ok({ items: window.__trend
        ? [[0, 300], [1, 150], [3, 30]].map(([daysAgo, amount], index) => ({ ...record('d' + index, '对话'), amount: -amount,
          created_at: new Date(Date.now() - daysAgo * 86400000).toISOString() }))
        : [record('t1', ${JSON.stringify(LONG)}), record('t2', '对话')] }) },
    },
    research: { toolCharges: { useQuery: () => ok(undefined) } },
  };
`;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'profile-small-fixes-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0fixture-trpc';
      if (id === '@/lib/supabase') return '\0fixture-supabase';
      if (id === 'next/navigation') return '\0fixture-navigation';
      if (id === 'next/link') return '\0fixture-link';
    }, load(id: string) {
      // Only what needs the running app is replaced: the tRPC client, the Supabase client, the router and next/link.
      if (id === '\0fixture-trpc') return trpcMock;
      if (id === '\0fixture-supabase') return 'export const createClient = () => ({ auth: {} });';
      if (id === '\0fixture-navigation') return 'export const useRouter = () => ({ push() {}, replace() {}, refresh() {} });';
      if (id === '\0fixture-link') return "import {createElement} from 'react'; export default function Link({prefetch,...rest}){return createElement('a',rest)}";
      if (id !== entry) return;
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../app/globals.css')};
        import { UserProfileHeader } from ${file('./PersonalInfoCard.tsx')};
        import { CreditRecordsCard } from ${file('./CreditRecordsCard.tsx')};
        import { SecuritySettingsCard } from ${file('./SecuritySettingsCard.tsx')};
        const user = { id: 'u1', email: 'tester@example.test', nickname: '测试用户', full_name: '测试用户', avatar_url: '', credits: 22563,
          subscription_tier: 'pro', auth_provider: 'email', email_verified: true, created_date: '2026-09-01T00:00:00Z' };
        const views = { header: UserProfileHeader, records: CreditRecordsCard, security: SecuritySettingsCard };
        createRoot(document.getElementById('root')).render(React.createElement('div', { className: 'p-4' }, React.createElement(views[window.__view], { user })));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ProfileSmallFixesTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find(item => item.type === 'chunk')?.code ?? '';
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(view: 'header' | 'records' | 'security', width: number, trend = false): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors: string[] = [];
  // A missing control fails with its own name within seconds instead of running into the test's time limit.
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<html lang="zh-Hans"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(([name, withTrend]) => Object.assign(window, { __view: name, __trend: withTrend }), [view, trend] as const);
  await page.addScriptTag({ content: code });
  return { page, errors };
}

for (const close of ['取消', 'Escape'] as const) {
  it(`the change-password dialog is empty when it is opened again after ${close === '取消' ? 'the cancel button' : 'the Escape key'}`, async () => {
    const { page, errors } = await open('security', 1024);
    try {
      const fields = ['#current-password', '#new-password', '#confirm-password'];
      await page.getByRole('button', { name: '修改', exact: true }).click();
      const dialog = page.getByRole('dialog');
      for (const field of fields) await dialog.locator(field).fill('typed-but-not-sent-1');
      if (close === '取消') await dialog.getByRole('button', { name: '取消' }).click(); else await page.keyboard.press('Escape');
      await browserExpect(dialog).toBeHidden();
      await page.getByRole('button', { name: '修改', exact: true }).click();
      for (const field of fields) await browserExpect(page.getByRole('dialog').locator(field)).toHaveValue('');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

for (const width of [360, 1280]) {
  it(`${width}px: a credit record with a very long description is cut with an ellipsis and does not widen the page`, async () => {
    const { page, errors } = await open('records', width);
    try {
      const description = page.getByText(LONG, { exact: true });
      await browserExpect(description).toBeVisible();
      const measured = await description.evaluate(element => ({ right: element.getBoundingClientRect().right, cut: element.scrollWidth > element.clientWidth,
        page: document.documentElement.scrollWidth, screen: window.innerWidth }));
      expect(measured.page, 'the page scrolls sideways').toBeLessThanOrEqual(measured.screen);
      expect(measured.right).toBeLessThanOrEqual(measured.screen);
      expect(measured.cut, 'the long description ends in an ellipsis').toBe(true);
      // The amount of the same record is still on screen.
      const amount = await page.getByText('-36 积分').first().evaluate(element => element.getBoundingClientRect().right);
      expect(amount).toBeLessThanOrEqual(measured.screen);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('the nickname save and cancel buttons have names, and cancel puts the nickname back', async () => {
  // 1024px: at 360px the cancel button is half cut off by the card's edge (an older layout problem, noted in the PR, not fixed here).
  const { page, errors } = await open('header', 1024);
  try {
    await page.getByRole('button', { name: '编辑昵称' }).click();
    await page.getByPlaceholder('输入昵称').fill('改了一半');
    await browserExpect(page.getByRole('button', { name: '保存昵称' })).toBeEnabled();
    await page.getByRole('button', { name: '取消修改昵称' }).click();
    await browserExpect(page.getByRole('heading', { name: '测试用户' })).toBeVisible();
    await browserExpect(page.getByPlaceholder('输入昵称')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

// Staging validation, 2026-11-13: "每日消耗趋势" showed 2,959 for 14 days and a flat row of bars. Each bar's height was a share of a
// box without a height of its own, so every bar fell back to its 4px minimum whatever the day's amount.
for (const width of [360, 1280]) {
  it(`${width}px: the daily trend's bars are as tall as their days' spending: the largest fills the chart, half is half, none is a faint mark`, async () => {
    const { page, errors } = await open('records', width, true);
    try {
      const chart = page.getByTestId('credit-trend');
      await browserExpect(chart).toBeVisible();
      const bars = await chart.locator('[title$=" 积分"]').evaluateAll(elements => elements.map(element => ({
        amount: Number(/: (\d+) 积分$/.exec(element.getAttribute('title') ?? '')?.[1]), height: element.getBoundingClientRect().height })));
      expect(bars).toHaveLength(14);
      const height = (amount: number) => bars.filter(bar => bar.amount === amount).map(bar => bar.height);
      const [full] = height(300), [half] = height(150), [tenth] = height(30);
      // The chart is 200px high; on a computer the date under each bar takes some of it.
      expect(full).toBeGreaterThan(150);
      expect(full).toBeLessThanOrEqual(200);
      expect(half / full).toBeCloseTo(0.5, 1);
      expect(tenth / full).toBeCloseTo(0.1, 1);
      // The eleven days without spending: a 2px mark each, not a bar.
      expect(height(0)).toEqual(Array(11).fill(2));
      // The bars stand on one line, inside the chart.
      const box = await chart.boundingBox();
      const bottoms = await chart.locator('[title$=" 积分"]')
        .evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().bottom)));
      expect(new Set(bottoms).size).toBe(1);
      expect(bottoms[0]).toBeLessThanOrEqual(Math.round(box!.y + box!.height));
      await browserExpect(page.getByText('14日总计')).toBeVisible();
      await browserExpect(page.getByText('480', { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}
