/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__packages_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const mock = `
    const plan = { id: 'plan-pro', name: 'Pro', level: 'pro', monthly_price: 990, yearly_price: 9900,
      stripe_monthly_price_id: 'price_m', stripe_yearly_price_id: 'price_y', monthly_credits: 1500, yearly_credits: 20000, monthly_bonus_credits: 0, package_discount: 100,
      max_context_messages: 20, features: [], is_active: 'true', sort_order: 1, created_at: '2026-01-01' };
    const pack = { id: 'pkg-1', name: 'Basic', price: 990, credits_amount: 1000, bonus_credits: 100, stripe_price_id: null,
      sort_order: 2, is_popular: 'true', active: 'true', created_at: '2026-01-01' };
    window.savedPlans = [];
    const mutation = { useMutation: (options) => ({ isPending: false, mutate: input => {
      window.savedPlans.push(input); options.onSuccess?.();
    } }) };
    export const trpc = { admin: {
      getPackagesDashboard: { useQuery: () => ({ data: { packages: [pack], membershipPlans: [plan] },
        isLoading: false, error: null, refetch: async () => ({ error: null }) }) },
      createPackage: mutation, updatePackage: mutation, deletePackage: mutation,
      createMembershipPlan: mutation, updateMembershipPlan: mutation, deleteMembershipPlan: mutation
    } };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'packages-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0packages-trpc';
    }, load(id: string) {
      if (id === '\0packages-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'PackagesTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

it('locks the tier when editing, keeps name editable, and allows choosing a tier when creating', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    await page.getByRole('tab', { name: '会员等级' }).click();
    await page.getByTestId('admin-membership-plan-edit-plan-pro').click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByRole('combobox')).toBeDisabled();
    await browserExpect(dialog.getByText('修改等级需同时设置会员权益，暂不支持')).toBeVisible();
    // Prices are read-only when editing (changing one is a migration) and are never sent.
    await browserExpect(dialog.getByTestId('membership-plan-monthly-price-input')).toBeDisabled();
    await browserExpect(dialog.getByTestId('membership-plan-yearly-price-input')).toBeDisabled();
    await browserExpect(dialog.getByText('月付价格 (USD)（只读，改价走迁移）')).toBeVisible();
    await dialog.getByTestId('membership-plan-name-input').fill('Renamed');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    expect(await page.evaluate('window.savedPlans[0]')).toMatchObject({ id: 'plan-pro', level: 'pro', name: 'Renamed' });
    expect(await page.evaluate('Object.keys(window.savedPlans[0])')).not.toContain('monthlyPrice');
    expect(await page.evaluate('Object.keys(window.savedPlans[0])')).not.toContain('yearlyPrice');
    // An unchanged Stripe price id is not resubmitted (the server would re-verify it against Stripe and could fail a rename).
    expect(await page.evaluate('Object.keys(window.savedPlans[0])')).not.toContain('stripeMonthlyPriceId');
    expect(await page.evaluate('Object.keys(window.savedPlans[0])')).not.toContain('stripeYearlyPriceId');
    await page.getByTestId('admin-membership-plan-edit-plan-pro').click();
    await dialog.getByPlaceholder('price_xxx').first().fill('price_new');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    expect(await page.evaluate('window.savedPlans[1]')).toMatchObject({ stripeMonthlyPriceId: 'price_new' });
    expect(await page.evaluate('Object.keys(window.savedPlans[1])')).not.toContain('stripeYearlyPriceId');
    await page.getByRole('button', { name: '创建会员等级', exact: true }).click();
    await browserExpect(dialog.getByRole('combobox')).toBeEnabled();
    await browserExpect(dialog.getByTestId('membership-plan-monthly-price-input')).toBeEnabled();
    await browserExpect(dialog.getByText('修改等级需同时设置会员权益，暂不支持')).toHaveCount(0);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Gold 黄金版' }).click();
    await browserExpect(dialog.getByRole('combobox')).toHaveText('Gold 黄金版');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

it('credit packs: the list and its counts, create, edit, the shelf toggle and delete send what the form holds', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.route('**/*', route => route.abort());
  const saved = (index: number) => page.evaluate(`window.savedPlans[${index}]`);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    const section = page.getByTestId('admin-packages-credit-section');
    await browserExpect(page.getByTestId('admin-credit-package-row-pkg-1')).toContainText('Basic');
    await browserExpect(page.getByTestId('admin-credit-package-row-pkg-1')).toContainText('+100');
    await browserExpect(section.getByText('热门')).toBeVisible();
    await browserExpect(page.getByText('总套餐数').locator('xpath=following-sibling::p')).toHaveText('1');
    await browserExpect(page.getByText('已下架', { exact: true }).locator('xpath=following-sibling::p')).toHaveText('0');

    await page.getByTestId('admin-credit-package-create-trigger').click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByText('创建积分包')).toBeVisible();
    await browserExpect(dialog.getByTestId('credit-package-save')).toBeDisabled();
    await dialog.getByTestId('credit-package-name-input').fill(' Starter ');
    await dialog.getByTestId('credit-package-price-input').fill('9.9');
    await dialog.getByTestId('credit-package-credits-input').fill('990');
    await dialog.getByTestId('credit-package-bonus-input').fill('99');
    await dialog.getByTestId('credit-package-save').click();
    expect(await saved(0)).toEqual({
      name: 'Starter', price: 990, creditsAmount: 990, bonusCredits: 99, sortOrder: 0, isPopular: 'false', active: 'true',
    });
    await browserExpect(dialog).toHaveCount(0);

    await page.getByTestId('admin-credit-package-edit-pkg-1').click();
    await browserExpect(dialog.getByText('编辑积分包')).toBeVisible();
    await browserExpect(dialog.getByTestId('credit-package-name-input')).toHaveValue('Basic');
    await browserExpect(dialog.getByTestId('credit-package-price-input')).toHaveValue('9.9');
    await dialog.getByTestId('credit-package-bonus-input').fill('123');
    await dialog.getByTestId('credit-package-save').click();
    expect(await saved(1)).toEqual({
      id: 'pkg-1', name: 'Basic', price: 990, creditsAmount: 1000, bonusCredits: 123, stripePriceId: null, sortOrder: 2,
      isPopular: 'true', active: 'true',
    });

    await page.getByTestId('admin-credit-package-toggle-pkg-1').click();
    expect(await saved(2)).toEqual({ id: 'pkg-1', active: 'false' });
    await page.getByTestId('admin-credit-package-delete-pkg-1').click();
    expect(await saved(3)).toEqual({ id: 'pkg-1' });

    await page.getByRole('tab', { name: '会员等级' }).click();
    await browserExpect(page.getByTestId('admin-membership-plan-row-plan-pro')).toContainText('Pro 专业版');
    await browserExpect(page.getByTestId('admin-membership-plan-row-plan-pro')).toContainText('月付 已配置');
    await page.getByTestId('admin-membership-plan-toggle-plan-pro').click();
    expect(await saved(4)).toEqual({ id: 'plan-pro', isActive: 'false' });
    await page.getByTestId('admin-membership-plan-delete-plan-pro').click();
    expect(await saved(5)).toEqual({ id: 'plan-pro' });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);
