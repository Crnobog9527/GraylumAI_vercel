/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real Chromium checks for three small admin/profile fixes, built with the app's Tailwind CSS and a
// controlled tRPC stand-in: the finance report's 1-day window, the edit form's price/capacity read,
// and the profile summary's retry after automatic retries gave up.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__small_fixes_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const shots = process.env.SMALL_FIXES_SCREENSHOTS;

const mock = `
  const capacity = { route: 'example/fp8', fetchedAt: '2026-10-01T00:00:00.000Z',
    inputLimit: { supplier: 272000, current: 272000, matches: true }, maxTokens: { supplier: 128000, current: 4096, matches: false } };
  const priceView = { status: 'ready', label: '已读取', route: 'example/fp8', fetchedAt: '2026-10-01T00:00:00.000Z',
    pricingHash: 'a'.repeat(64), source: 'openrouter', promptTokensUpper: 272000, base: { prompt: '1.25', completion: '10' },
    frozen: { promptUsdPerMillion: '2.5', completionUsdPerMillion: '15', requestUsd: '0', explain: { prompt: '输入', completion: '输出' } } };
  const pricing = { fetchedAt: '2026-10-01T00:00:00.000Z', model: 'example/model', source: 'openrouter', pricingHash: 'a'.repeat(64),
    endpoints: [{ tag: 'example/fp8', contextLength: 272000, admissible: true, issues: [], discount: null, unknownKeys: [],
      base: { prompt: '1.25', completion: '10' }, raw: {}, overrides: [] }] };
  const view = { model: 'example/model', maxTokens: 4096, issues: [], capacity, priceView, pricing,
    config: { route: 'example/fp8', purposes: {}, catalog: { fetchedAt: '2026-10-01T00:00:00.000Z', model: 'example/model' } } };
  const state = window.__fix = { reportInputs: [], reads: 0, readError: null, refetches: 0, summaryError: true, view };
  const report = { available: true, truncated: false, models: [], byPurpose: [], byDate: [],
    totals: { calls: 0, runs: 0, officialCostUsd: '0', weightedUsd: '0', chargedCredits: 0, unallocatedChargedCredits: 0,
      refundedRuns: 0, unparsableCalls: 0 } };
  export const trpc = {
    useUtils: () => ({ modelReasoning: { get: { setData: (_, value) => { state.view = value; window.rerender(); } } },
      modelPricing: { getMultipliers: { invalidate() {} } }, model: { getAdminModelsDashboard: { invalidate() {} } } }),
    billingReport: { bill2ByModel: { useQuery: (input) => { state.reportInputs.push(input.days); return { data: report }; } } },
    modelPricing: { getMultipliers: { useQuery: () => ({ data: { site: { creditsPerUsd: '100' }, models: [{ id: 'model-1', effective: '2' }] } }) } },
    modelReasoning: {
      get: { useQuery: () => ({ data: state.view, error: null }) },
      refreshCatalog: { useMutation: (options) => ({ isPending: false, error: state.readError, mutate: () => {
        state.reads++;
        if (state.readError) return;
        options.onSuccess({ ...state.view,
          capacity: { ...capacity, maxTokens: { supplier: 128000, current: 128000, matches: true } },
          previousCapacity: capacity,
          priceChanges: [{ tag: 'example/fp8', change: 'changed', field: 'prompt', before: '1.25', after: '1.5' }] });
      } }) },
    },
    credits: { getCreditsSummary: { useQuery: () => ({
      data: state.summaryError ? undefined : { totalSpent: 321 }, isError: state.summaryError, isFetching: false,
      refetch: async () => { state.refetches++; state.summaryError = false; window.rerender(); },
    }) } },
  };
`;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const styles = fileURLToPath(new URL('../../app/globals.css', import.meta.url));
  const card = fileURLToPath(new URL('./Bill2ModelReportCard.tsx', import.meta.url));
  const section = fileURLToPath(new URL('./ModelEditPriceSection.tsx', import.meta.url));
  const profile = fileURLToPath(new URL('../profile/PersonalInfoCard.tsx', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'small-fixes-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0small-fixes-trpc';
      if (id === '@/lib/supabase') return '\0small-fixes-supabase';
    }, load(id: string) {
      if (id === '\0small-fixes-trpc') return mock;
      if (id === '\0small-fixes-supabase') return 'export const createClient = () => ({});';
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${JSON.stringify(styles)};
        import { Bill2ModelReportCard } from ${JSON.stringify(card)};
        import { ModelEditPriceSection } from ${JSON.stringify(section)};
        import { CreditsAndSubscriptionCards } from ${JSON.stringify(profile)};
        const root = createRoot(document.getElementById('root'));
        const user = { id: 'u1', email: '', nickname: 'u', full_name: 'u', avatar_url: '', credits: 500, subscription_tier: 'free',
          auth_provider: 'email', email_verified: true, created_date: '2026-01-01' };
        const views = {
          report: () => React.createElement(Bill2ModelReportCard),
          edit: () => React.createElement(ModelEditPriceSection, { modelId: 'model-1', open: true, onShowMultipliers() {} }),
          profile: () => React.createElement(CreditsAndSubscriptionCards, { user: { ...user } }),
        };
        window.rerender = () => root.render(React.createElement('div', { className: 'p-4' }, views[window.__view]()));
        window.rerender();`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'SmallFixesTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item) => item.type === 'chunk')?.code ?? '';
  css = String(output.find((item) => item.fileName.endsWith('.css'))?.source ?? '');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(view: string, width = 1024): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate((name) => { (window as unknown as { __view: string }).__view = name; }, view);
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const fix = (page: Page, key: string) => page.evaluate(`window.__fix.${key}`);

describe('admin small fixes in Chromium', () => {
  it('finance report offers a 1-day window and asks the server for 1 day', async () => {
    const { page, errors } = await open('report');
    try {
      const oneDay = page.getByRole('button', { name: '近 1 天' });
      const active = await page.getByRole('button', { name: '近 30 天' }).getAttribute('class');
      await oneDay.click();
      await page.mouse.move(0, 0);
      await browserExpect(oneDay).toHaveAttribute('class', active ?? '');
      expect(((await fix(page, 'reportInputs')) as number[]).at(-1)).toBe(1);
      await page.waitForTimeout(400); // buttons fade colours over 200 ms
      await shot(page, 'finance-1-day');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it('edit form reads prices and capacity and shows what changed', async () => {
    const { page, errors } = await open('edit');
    try {
      await browserExpect(page.getByText('当前值和供应商不一致，请点本区的"读取价格和容量"同步。')).toBeVisible();
      await page.getByRole('button', { name: '读取价格和容量' }).click();
      expect(await fix(page, 'reads')).toBe(1);
      await browserExpect(page.getByText('和上次读取相比：')).toBeVisible();
      await browserExpect(page.getByText(/本次读取已按供应商同步/)).toBeVisible();
      await shot(page, 'edit-read');
      await page.evaluate(`window.__fix.readError = ${JSON.stringify({ message: 'fetch failed: internal token', data: { code: 'INTERNAL_SERVER_ERROR' } })}; window.rerender();`);
      await browserExpect(page.getByRole('alert')).toHaveText('暂时无法读取模型目录，请稍后重试');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it('profile shows a readable failure with a working retry button, also at 375px', async () => {
    const { page, errors } = await open('profile', 375);
    try {
      await browserExpect(page.getByText('本月消耗暂时无法读取')).toBeVisible();
      await browserExpect(page.locator('.animate-spin')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      await shot(page, 'profile-retry-375');
      await page.getByRole('button', { name: '重试' }).click();
      expect(await fix(page, 'refetches')).toBe(1);
      await browserExpect(page.getByText('本月已消耗 321 积分')).toBeVisible();
      await browserExpect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
});
