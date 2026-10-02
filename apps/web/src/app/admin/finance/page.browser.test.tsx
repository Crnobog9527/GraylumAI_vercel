/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real Chromium layout check for the finance page: the page bundle is built with the app's
// Tailwind CSS and a controlled finance response, so bar heights and widths are actual pixels.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyPrice } from '@/components/admin/modelPriceFixtures';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__finance_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../', import.meta.url));

const model = (id: string, isActive: string | boolean) => ({ id, name: id, modelId: `example/${id}`, provider: 'openai',
  isActive, pricing: readyPrice, maxTokens: 4096, conversationCount: 0, requestCount: 0, creditsConsumed: 0, costUsd: 0 });
const pkg = (id: string, active: string) => ({ id, name: id, price: 500, creditsAmount: 500, active });
const day = (date: string, additions: number, checkins: number) =>
  ({ date, additions, checkins, purchases: 0, deductions: 40, unknownTypeCount: 0 });
const financeData = (unknown: boolean) => ({
  transactions: { totalAdditions: 20, totalCheckins: unknown ? 20 : 0, totalDeductions: 80, totalPurchases: 0,
    totalRefunds: 0, todayTransactions: 1, weekTransactions: 2, monthTransactions: 2,
    unknownTypeCount: unknown ? 2 : 0, unknownTypes: unknown ? { bonus: 2 } : {} },
  users: { totalUsers: 1, totalCreditsInSystem: 100, averageCreditsPerUser: 100, newUsersThisMonth: 0, newUsersThisWeek: 0 },
  packages: { totalPackages: 2, activePackages: 1, unknownActiveCount: unknown ? 1 : 0,
    packages: [pkg('basic', 'true'), pkg('legacy', unknown ? 'paused' : 'false')] },
  dailyChart: unknown ? [day('2026-10-01', 10, 0), day('2026-10-02', 10, 20)] : [day('2026-10-01', 10, 0)],
  apiStats: { totalRequests: 0, totalConversations: 0, messagesThisMonth: 0, messagesThisWeek: 0 },
  modelStats: [model('flagged', true), model('beta', unknown ? 'beta' : 'false')],
  financeOverview: { paidRevenueCents: 0, recordedCostUsd: 0, estimatedProfitUsd: 0, creditsConsumed: 80,
    creditsPurchased: 0, creditsGiven: unknown ? 40 : 20, netCreditsFlow: -40 },
  runtimeBilling: { creditsPerUsd: 100, tokenPriceMultiplier: 1.5, billingUnitSource: null, activeModelCount: 1,
    unknownModelActiveCount: unknown ? 1 : 0, inputCreditsPer1KRange: null, outputCreditsPer1KRange: null,
    searchCreditsPer1KRange: null, searchSurchargeCredits: 0, newUserCredits: 100 },
});

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const styles = fileURLToPath(new URL('../../globals.css', import.meta.url));
  const mock = `const query = (data) => ({ useQuery: () => ({ data, isLoading: false, error: null, refetch() {} }) });
    export const trpc = { admin: { getFinanceStats: query(window.financeData) },
      billingReport: { bill2ByModel: query(undefined) } };`;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'finance-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0finance-trpc';
    }, load(id: string) {
      if (id === '\0finance-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${JSON.stringify(styles)}; import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'FinanceTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] =
    Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item) => item.type === 'chunk')?.code ?? '';
  css = String(output.find((item) => item.fileName.endsWith('.css'))?.source ?? '');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(unknown: boolean, width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate((data) => { (window as unknown as { financeData: unknown }).financeData = data; }, financeData(unknown));
  await page.addScriptTag({ content: code });
  await browserExpect(page.getByTestId('admin-finance-page')).toBeVisible();
  return { page, errors };
}

const height = async (page: Page, date: string) =>
  (await page.getByTestId(`admin-finance-day-${date}`).locator('[data-bar="given"]').boundingBox())?.height ?? 0;

describe('admin finance page in Chromium', () => {
  it('scales the 赠送 bar with check-ins and flags unknown values', async () => {
    const { page, errors } = await open(true);
    try {
      expect(css).toContain('.h-40');
      await browserExpect(page.getByTestId('admin-finance-credits-given')).toHaveText('+40（含签到 20）');
      const notice = page.getByTestId('admin-finance-unknown-notice');
      await browserExpect(notice).toBeVisible();
      await browserExpect(page.getByTestId('admin-finance-unknown-transactionType')).toContainText('2 条bonus × 2');
      await browserExpect(page.getByTestId('admin-finance-unknown-packageStatus')).toContainText('1 条paused × 1');
      await browserExpect(page.getByTestId('admin-finance-unknown-modelStatus')).toContainText('1 条beta × 1');
      const [plain, withCheckins] = [await height(page, '2026-10-01'), await height(page, '2026-10-02')];
      expect(plain).toBeGreaterThan(30); // 10 of 40 in a 160px chart
      expect(withCheckins / plain).toBeGreaterThan(2.5); // 30 of 40
      await browserExpect(page.getByRole('row', { name: /legacy/ })).toContainText('paused（未知状态）');
      await browserExpect(page.getByRole('row', { name: /legacy/ })).not.toContainText('已下架');
      await page.getByRole('tab', { name: '模型渠道' }).click();
      await browserExpect(page.getByTestId('admin-finance-model-row-beta')).toContainText('beta（未知状态）');
      await browserExpect(page.getByTestId('admin-finance-model-row-beta')).not.toContainText('禁用');
      await browserExpect(page.getByTestId('admin-finance-model-row-flagged')).toContainText('启用');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it('shows no notice and the known labels when every value is known', async () => {
    const { page, errors } = await open(false);
    try {
      await browserExpect(page.getByTestId('admin-finance-credits-given')).toHaveText('+20');
      await browserExpect(page.getByTestId('admin-finance-unknown-notice')).toHaveCount(0);
      await browserExpect(page.getByRole('row', { name: /legacy/ })).toContainText('已下架');
      await page.getByRole('tab', { name: '模型渠道' }).click();
      await browserExpect(page.getByTestId('admin-finance-model-row-beta')).toContainText('禁用');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);

  it('fits a 375px screen without horizontal page scroll', async () => {
    const { page, errors } = await open(true, 375);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      for (const id of ['admin-finance-unknown-notice', 'admin-finance-credits-given', 'admin-finance-daily-chart']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
      }
      expect(await height(page, '2026-10-02')).toBeGreaterThan(await height(page, '2026-10-01') * 2.5);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
});
