/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real Chromium check of /admin/settings "会员权限": the page is built with the app's Tailwind CSS and a
// stateful stand-in for the server (same input limits as PR-1's procedures, save then re-read), so
// edit → save → read back, refusals and failures are exercised through the actual page.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let code: string;
let css: string;
const entry = fileURLToPath(new URL('./__membership_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../', import.meta.url));
const shots = process.env.ENTITLEMENTS_SCREENSHOTS;

const mock = `
  import React from 'react';
  import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
  const plan = (level, review, compare, bytes) => ({ id: '00000000-0000-4000-8000-00000000000' + ['free', 'pro', 'gold'].indexOf(level),
    name: level.toUpperCase() + ' 会员', level, allow_export: 'false', allow_batch_export: 'false', allow_fusion_review: review,
    allow_fusion_compare: compare, library_storage_bytes: bytes, monthly_price: 0, sort_order: 0 });
  const srv = window.__srv = {
    plans: [plan('free', false, false, 50000000), plan('pro', true, true, 500000000), plan('gold', true, true, 2000000000)],
    settings: { fusion_compare_max_models: 4 }, planCalls: [], settingCalls: [], failNextSave: null, failNextRead: false,
    failFirstRead: false, reads: 0,
  };
  // A real TanStack Query client, so a failed refetch puts the dashboard query into its error state.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  export const TestProvider = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const badRequest = (message) => ({ message: JSON.stringify([{ code: 'custom', path: ['value'], message }]), data: { code: 'BAD_REQUEST' } });
  // Same limits as admin.updateMembershipPlan and settings.updateSystemSettings (PR-1).
  const checkPlan = (input) => Number.isSafeInteger(input.libraryStorageBytes) && input.libraryStorageBytes >= 0
    && typeof input.allowFusionReview === 'boolean' && typeof input.allowFusionCompare === 'boolean' ? null : badRequest('Too small');
  const checkSetting = (input) => input.key === 'fusion_compare_max_models' && Number.isInteger(input.value) && input.value >= 2
    && input.value <= 8 ? null : badRequest('对比模型上限须为 2 至 8 的整数');
  const mutation = (calls, check, apply) => (options) => {
    const [state, setState] = React.useState({ isPending: false, error: null });
    return { ...state, reset: () => setState({ isPending: false, error: null }), mutate: (input) => {
      calls.push(input);
      setState({ isPending: true, error: null });
      setTimeout(async () => {
        const error = srv.failNextSave ?? check(input);
        srv.failNextSave = null;
        if (error) return setState({ isPending: false, error });
        apply(input);
        await options?.onSuccess?.(input);
        setState({ isPending: false, error: null });
      }, 30);
    } };
  };
  const dashboard = () => ({ systemSettings: { ...srv.settings }, membershipPlans: srv.plans.map((p) => ({ ...p })) });
  const readDashboard = async () => {
    await new Promise((r) => setTimeout(r, 20));
    const fail = srv.reads++ === 0 ? srv.failFirstRead : srv.failNextRead;
    if (fail) { srv.failNextRead = false; throw new Error('读取设置页数据失败，请稍后重试'); }
    return dashboard();
  };
  const generic = new Proxy({}, { get: (_, key) => key === 'useQuery' ? () => ({ data: undefined, isLoading: false, error: null,
    refetch: async () => ({}) }) : key === 'useMutation' ? () => ({ mutate() {}, mutateAsync: async () => ({}), isPending: false, error: null,
    reset() {} }) : key === 'useUtils' ? () => generic : typeof key === 'string' && key.startsWith('invalidate') ? async () => {} : generic });
  export const trpc = new Proxy({
    admin: new Proxy({
      getSettingsDashboard: { useQuery: () => useQuery({ queryKey: ['settingsDashboard'], queryFn: readDashboard }) },
      updateMembershipPlan: { useMutation: mutation(srv.planCalls, checkPlan, (input) => {
        const row = srv.plans.find((p) => p.id === input.id);
        Object.assign(row, { allow_export: input.allowExport, allow_batch_export: input.allowBatchExport,
          allow_fusion_review: input.allowFusionReview, allow_fusion_compare: input.allowFusionCompare,
          library_storage_bytes: input.libraryStorageBytes });
      }) },
    }, { get: (target, key) => target[key] ?? generic[key] }),
    settings: new Proxy({
      updateSystemSettings: { useMutation: mutation(srv.settingCalls, checkSetting, (input) => { srv.settings[input.key] = input.value; }) },
    }, { get: (target, key) => target[key] ?? generic[key] }),
  }, { get: (target, key) => target[key] ?? generic[key] });
`;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const styles = fileURLToPath(new URL('../../globals.css', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } },
    resolve: { alias: { '@': src } },
    plugins: [{ name: 'membership-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0membership-trpc';
    }, load(id: string) {
      if (id === '\0membership-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${JSON.stringify(styles)}; import Page from ${JSON.stringify(source)};
        import { TestProvider } from '@/trpc/client';
        window.__mount = () => createRoot(document.getElementById('root'))
          .render(React.createElement(TestProvider, null, React.createElement(Page)));
        window.__mount();`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'MembershipTest', formats: ['iife'] } },
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

async function open(width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: code });
  await page.getByRole('tab', { name: '会员权限' }).click();
  await browserExpect(page.getByTestId('admin-settings-membership-section')).toBeVisible();
  return { page, errors };
}
const srv = (page: Page, expr: string) => page.evaluate(`window.__srv.${expr}`);
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};
const free = 'membership-plan-free';

describe('admin membership permissions in Chromium', () => {
  it('shows the saved D4 values and says the features are not live yet', async () => {
    const { page, errors } = await open();
    try {
      await browserExpect(page.getByTestId(`${free}-allow-fusion-review`)).toHaveAttribute('aria-checked', 'false');
      await browserExpect(page.getByTestId('membership-plan-pro-allow-fusion-compare')).toHaveAttribute('aria-checked', 'true');
      await browserExpect(page.getByTestId(`${free}-storage`)).toHaveValue('50');
      await browserExpect(page.getByTestId('membership-plan-gold-storage')).toHaveValue('2000');
      await browserExpect(page.getByTestId('membership-plan-gold')).toContainText('2 GB（2,000,000,000 字节）');
      await browserExpect(page.getByTestId('membership-entitlements-not-live')).toContainText('还没有上线');
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toHaveValue('4');
      await browserExpect(page.getByTestId(`membership-plan-save-free`)).toBeDisabled();
      await shot(page, 'membership-tab');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('saves both Fusion switches and storage, then shows the values read back after a remount', async () => {
    const { page, errors } = await open();
    try {
      await page.getByTestId(`${free}-allow-fusion-review`).click();
      await page.getByTestId(`${free}-storage`).fill('1.5');
      await browserExpect(page.getByTestId(free)).toContainText('有未保存的修改');
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(page.getByTestId(free)).toContainText('已保存并读回');
      expect(await srv(page, 'planCalls')).toEqual([{ id: '00000000-0000-4000-8000-000000000000', allowExport: 'false',
        allowBatchExport: 'false', allowFusionReview: true, allowFusionCompare: false, libraryStorageBytes: 1_500_000 }]);
      expect(await srv(page, 'plans[0].library_storage_bytes')).toBe(1_500_000);
      // Only the edited switch changed; compare stays independent.
      await page.getByTestId(`${free}-allow-fusion-compare`).click();
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(page.getByTestId(free)).toContainText('已保存并读回');
      expect(await page.evaluate('[window.__srv.plans[0].allow_fusion_review, window.__srv.plans[0].allow_fusion_compare]')).toEqual([true, true]);
      // A fresh page shows the server's values, not a local draft.
      await page.evaluate(`document.getElementById('root').remove(); document.body.insertAdjacentHTML('beforeend', '<div id="root"></div>'); window.__mount();`);
      await page.getByRole('tab', { name: '会员权限' }).click();
      await browserExpect(page.getByTestId(`${free}-storage`)).toHaveValue('1.5');
      await browserExpect(page.getByTestId(`${free}-allow-fusion-review`)).toHaveAttribute('aria-checked', 'true');
      await browserExpect(page.getByTestId(free)).toContainText('1.5 MB（1,500,000 字节）');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('refuses invalid storage locally and shows a server refusal or failed read without a fake success', async () => {
    const { page, errors } = await open();
    try {
      for (const bad of ['-1', '1.2345678', 'abc']) {
        await page.getByTestId(`${free}-storage`).fill(bad);
        await browserExpect(page.getByTestId(free).getByRole('alert')).toContainText('请填写不小于 0 的数字');
        await browserExpect(page.getByTestId('membership-plan-save-free')).toBeDisabled();
      }
      expect(await srv(page, 'planCalls.length')).toBe(0);
      await page.getByTestId(`${free}-storage`).fill('60');
      await page.evaluate(`window.__srv.failNextSave = ${JSON.stringify({ message: '[{"message":"Too small"}]', data: { code: 'BAD_REQUEST' } })}`);
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(page.getByTestId(free).getByRole('alert')).toHaveText('服务端拒绝了这些值：资料库空间须为不小于 0 的整数字节，请检查后重试。');
      await browserExpect(page.getByTestId(free)).not.toContainText('已保存');
      expect(await srv(page, 'plans[0].library_storage_bytes')).toBe(50_000_000);
      await page.evaluate(`window.__srv.failNextSave = ${JSON.stringify({ message: 'permission denied for table membership_plans' })}`);
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(page.getByTestId(free).getByRole('alert')).toHaveText('保存会员权限失败，请稍后重试');
      await page.evaluate('window.__srv.failNextRead = true');
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(page.getByTestId(free).getByRole('alert')).toContainText('重新读取失败');
      await browserExpect(page.getByTestId(free)).not.toContainText('已保存并读回');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('keeps a saved row locked after a failed read-back so a later edit cannot undo the save', async () => {
    const { page, errors } = await open();
    const row = page.getByTestId(free);
    try {
      await page.getByTestId(`${free}-storage`).fill('60');
      await page.evaluate('window.__srv.failNextRead = true');
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(row.getByRole('alert')).toContainText('重新读取失败');
      // The dashboard query is really in its error state, yet the editors stay mounted.
      await browserExpect(page.getByTestId('admin-settings-reread-failed')).toBeVisible();
      await browserExpect(page.getByTestId('admin-settings-membership-section')).toBeVisible();
      expect(await srv(page, 'plans[0].library_storage_bytes')).toBe(60_000_000);
      // The saved value stays on screen; nothing in the row can be edited or resubmitted.
      await browserExpect(page.getByTestId(`${free}-storage`)).toHaveValue('60');
      await browserExpect(page.getByTestId(`${free}-storage`)).toBeDisabled();
      await browserExpect(page.getByTestId(`${free}-allow-fusion-review`)).toBeDisabled();
      await browserExpect(page.getByTestId('membership-plan-save-free')).toBeDisabled();
      await browserExpect(row).not.toContainText('已保存并读回');
      // A failed re-read keeps the lock.
      await page.evaluate('window.__srv.failNextRead = true');
      await page.getByTestId(`${free}-reread`).click();
      await browserExpect(page.getByTestId(`${free}-reread`)).toBeEnabled();
      await browserExpect(page.getByTestId(`${free}-storage`)).toBeDisabled();
      // A successful read unlocks the row with the server's values.
      await page.getByTestId(`${free}-reread`).click();
      await browserExpect(row).toContainText('已保存并读回');
      await browserExpect(page.getByTestId('admin-settings-reread-failed')).toHaveCount(0);
      await browserExpect(page.getByTestId(`${free}-storage`)).toBeEnabled();
      await browserExpect(page.getByTestId(`${free}-storage`)).toHaveValue('60');
      // Editing another field afterwards keeps the saved storage.
      await page.getByTestId(`${free}-allow-fusion-review`).click();
      await page.getByTestId('membership-plan-save-free').click();
      await browserExpect(row).toContainText('已保存并读回');
      expect(await srv(page, 'plans[0].library_storage_bytes')).toBe(60_000_000);
      expect(await srv(page, 'plans[0].allow_fusion_review')).toBe(true);
      expect(((await srv(page, 'planCalls')) as Array<{ libraryStorageBytes: number }>).map((c) => c.libraryStorageBytes))
        .toEqual([60_000_000, 60_000_000]);

      // The compare limit behaves the same way.
      const section = page.getByTestId('admin-settings-fusion-section');
      await page.getByTestId('admin-setting-fusion-compare').fill('6');
      await page.evaluate('window.__srv.failNextRead = true');
      await page.getByTestId('admin-setting-fusion-compare-save').click();
      await browserExpect(section.getByRole('alert')).toContainText('重新读取失败');
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toHaveValue('6');
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toBeDisabled();
      await page.getByTestId('admin-setting-fusion-compare-reread').click();
      await browserExpect(section).toContainText('已保存并读回');
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toHaveValue('6');
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toBeEnabled();
      expect(await srv(page, 'settings.fusion_compare_max_models')).toBe(6);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('saves the compare limit 2–8 as a number and refuses other values', async () => {
    const { page, errors } = await open();
    const input = page.getByTestId('admin-setting-fusion-compare');
    const save = page.getByTestId('admin-setting-fusion-compare-save');
    const section = page.getByTestId('admin-settings-fusion-section');
    try {
      for (const bad of ['9', '1', '4.5', '']) {
        await input.fill(bad);
        await browserExpect(section.getByRole('alert')).toHaveText('须为 2 至 8 的整数');
        await browserExpect(save).toBeDisabled();
      }
      await input.fill('8');
      await save.click();
      await browserExpect(section).toContainText('已保存并读回');
      expect(await srv(page, 'settingCalls')).toEqual([{ key: 'fusion_compare_max_models', value: 8 }]);
      await browserExpect(input).toHaveValue('8');
      await input.fill('5');
      await page.evaluate(`window.__srv.failNextSave = ${JSON.stringify({ message: '[{"message":"对比模型上限须为 2 至 8 的整数"}]', data: { code: 'BAD_REQUEST' } })}`);
      await save.click();
      await browserExpect(section.getByRole('alert')).toHaveText('服务端拒绝了这个值：须为 2 至 8 的整数。');
      expect(await srv(page, 'settings.fusion_compare_max_models')).toBe(8);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('says a missing compare limit blocks new requests instead of guessing one', async () => {
    const page = await browser.newPage();
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: code.replace('settings: { fusion_compare_max_models: 4 }', "settings: { fusion_compare_max_models: '4' }") });
      await page.getByRole('tab', { name: '会员权限' }).click();
      await browserExpect(page.getByTestId('admin-setting-fusion-compare')).toHaveValue('');
      await browserExpect(page.getByTestId('admin-settings-fusion-section').getByRole('alert')).toContainText('当前没有有效的配置');
    } finally { await page.close(); }
  }, 30000);

  it('keeps unsaved edits in other tabs when the Fusion limit is saved and re-read', async () => {
    const { page, errors } = await open();
    try {
      await page.getByRole('tab', { name: '基础设置' }).click();
      await page.getByTestId('admin-setting-site_name').fill('未保存的名称');
      await page.getByRole('tab', { name: '会员权限' }).click();
      await page.getByTestId('admin-setting-fusion-compare').fill('7');
      await page.getByTestId('admin-setting-fusion-compare-save').click();
      await browserExpect(page.getByTestId('admin-settings-fusion-section')).toContainText('已保存并读回');
      await page.getByRole('tab', { name: '基础设置' }).click();
      await browserExpect(page.getByTestId('admin-setting-site_name')).toHaveValue('未保存的名称');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it('still shows the full-page error when the first load fails', async () => {
    const page = await browser.newPage();
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<html><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: code.replace('failFirstRead: false', 'failFirstRead: true') });
      await browserExpect(page.getByText('读取设置页数据失败，请稍后重试')).toBeVisible();
      await browserExpect(page.getByTestId('admin-settings-membership-section')).toHaveCount(0);
    } finally { await page.close(); }
  }, 30000);

  it('fits a 375px screen without horizontal page scroll', async () => {
    const { page, errors } = await open(375);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      for (const id of [free, 'membership-plan-gold', 'admin-settings-fusion-section']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
      }
      await shot(page, 'membership-375');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
