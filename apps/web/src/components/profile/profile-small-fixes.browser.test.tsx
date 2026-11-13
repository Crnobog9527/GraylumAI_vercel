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
      getCreditTransactions: { useQuery: () => ok({ items: [record('t1', ${JSON.stringify(LONG)}), record('t2', '对话')] }) },
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

async function open(view: 'header' | 'records' | 'security', width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors: string[] = [];
  // A missing control fails with its own name within seconds instead of running into the test's time limit.
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<html lang="zh-Hans"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.evaluate(name => { (window as unknown as { __view: string }).__view = name; }, view);
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
