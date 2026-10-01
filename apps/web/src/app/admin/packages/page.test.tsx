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
      monthly_credits: 1500, yearly_credits: 20000, monthly_bonus_credits: 0, package_discount: 100,
      max_context_messages: 20, features: [], is_active: 'true', sort_order: 1, created_at: '2026-01-01' };
    window.savedPlans = [];
    const mutation = { useMutation: (options) => ({ isPending: false, mutate: input => {
      window.savedPlans.push(input); options.onSuccess?.();
    } }) };
    export const trpc = { admin: {
      getPackagesDashboard: { useQuery: () => ({ data: { packages: [], membershipPlans: [plan] },
        isLoading: false, error: null, refetch: async () => ({ error: null }) }) },
      createPackage: mutation, updatePackage: mutation, deletePackage: mutation,
      createMembershipPlan: mutation, updateMembershipPlan: mutation, deleteMembershipPlan: mutation
    } };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
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
    await dialog.getByTestId('membership-plan-name-input').fill('Renamed');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    expect(await page.evaluate('window.savedPlans[0]')).toMatchObject({ id: 'plan-pro', level: 'pro', name: 'Renamed' });
    await page.getByRole('button', { name: '创建会员等级', exact: true }).click();
    await browserExpect(dialog.getByRole('combobox')).toBeEnabled();
    await browserExpect(dialog.getByText('修改等级需同时设置会员权益，暂不支持')).toHaveCount(0);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Gold 黄金版' }).click();
    await browserExpect(dialog.getByRole('combobox')).toHaveText('Gold 黄金版');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);
