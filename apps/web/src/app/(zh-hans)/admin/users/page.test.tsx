/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The admin "用户管理" page in a real browser with the server calls replaced: what each control asks for and sends.
// Written against the page while it was one 843-line file; it has to keep passing unchanged when the page is split.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__users_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const mock = `
    const user = over => ({ id: 'u1', email: 'a@example.com', phone: null, nickname: '阿甲', avatar_url: null, role: 'user',
      status: 'active', membership_level: 'free', credits: 120, last_login_at: null, last_ip: null,
      created_at: '2026-01-02T00:00:00Z', ...over });
    const users = [user({}), user({ id: 'u2', email: 'b@example.com', nickname: null, role: 'admin', status: 'disabled',
      membership_level: 'pro', credits: 0, login_record_status: 'unrecorded' })];
    const details = { profile: user({ last_ip: '203.0.113.9' }),
      stats: { totalConversations: 7, totalMessages: 30, totalCreditsSpent: 1234, totalTickets: 2 },
      recentActivity: [{ id: 'l1', action: '调整积分', action_type: 'credit_adjust', details: {}, created_at: '2026-01-03T00:00:00Z' }] };
    window.calls = []; window.queries = []; window.detailQueries = []; window.invalidated = 0;
    const mutation = name => ({ useMutation: options => ({ isPending: false, mutate: input => {
      window.calls.push([name, input]);
      void options?.onSuccess?.({ auditRecorded: true }, input);
    } }) });
    const invalidate = async () => { window.invalidated++; };
    export const trpc = {
      useUtils: () => ({ admin: { getAllUsers: { invalidate }, getUserDetails: { invalidate } } }),
      admin: {
        getAllUsers: { useQuery: input => { window.queries.push(input);
          return { data: { users, total: 45 }, isLoading: false, error: null, refetch: async () => ({}) }; } },
        getUserDetails: { useQuery: (input, options) => { if (options.enabled) window.detailQueries.push(input);
          return { data: options.enabled ? details : undefined, isLoading: false }; } },
        adjustUserCredits: mutation('adjustUserCredits'), updateUserStatus: mutation('updateUserStatus'),
        updateUserMembership: mutation('updateUserMembership'), updateUserRole: mutation('updateUserRole'),
      },
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'users-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0users-trpc';
    }, load(id: string) {
      if (id === '\0users-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'UsersTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const lastQuery = (page: Page) => page.evaluate('window.queries.at(-1)');
const calls = (page: Page) => page.evaluate('window.calls') as Promise<[string, unknown][]>;
async function choose(page: Page, trigger: ReturnType<Page['getByRole']>, option: string) {
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

it('the list: what it shows, what each filter and the pager ask for, and what the three row selects send', async () => {
  const { page, errors } = await open();
  try {
    const first = page.getByTestId('admin-user-row-u1');
    const second = page.getByTestId('admin-user-row-u2');
    await browserExpect(page.getByText('管理平台用户、权限和积分 · 共 45 位用户')).toBeVisible();
    await browserExpect(first).toContainText('阿甲');
    await browserExpect(first).toContainText('a@example.com');
    await browserExpect(first).toContainText('120');
    await browserExpect(first).toContainText('从未登录');
    await browserExpect(second).toContainText('未设置昵称');
    await browserExpect(second).toContainText('未记录');
    await browserExpect(page.getByTestId('admin-user-status-u2')).toHaveText('禁用');
    await browserExpect(page.getByTestId('admin-user-membership-u2')).toHaveText('Pro 专业版');
    expect(await lastQuery(page)).toEqual({ limit: 20, offset: 0 });

    const filters = page.getByTestId('admin-users-filters');
    await browserExpect(page.getByRole('button', { name: '清除筛选' })).toHaveCount(0);
    await page.getByTestId('admin-users-search').fill('甲');
    expect(await lastQuery(page)).toEqual({ limit: 20, offset: 0, search: '甲' });
    await choose(page, filters.getByRole('combobox').nth(0), '禁用');
    await choose(page, filters.getByRole('combobox').nth(1), 'Gold 黄金版');
    await choose(page, filters.getByRole('combobox').nth(2), '管理员');
    expect(await lastQuery(page)).toEqual({ limit: 20, offset: 0, search: '甲', status: 'disabled', membershipLevel: 'gold', role: 'admin' });
    await page.getByRole('button', { name: '清除筛选' }).click();
    expect(await lastQuery(page)).toEqual({ limit: 20, offset: 0 });
    await browserExpect(page.getByTestId('admin-users-search')).toHaveValue('');

    await choose(page, page.getByTestId('admin-user-status-u1'), '封禁');
    await choose(page, page.getByTestId('admin-user-membership-u1'), 'Gold 黄金版');
    await choose(page, page.getByTestId('admin-user-role-u1'), '管理员');
    expect(await calls(page)).toEqual([
      ['updateUserStatus', { userId: 'u1', status: 'banned' }],
      ['updateUserMembership', { userId: 'u1', membershipLevel: 'gold' }],
      ['updateUserRole', { userId: 'u1', role: 'admin' }],
    ]);
    // each success refreshes the list and the open details
    expect(await page.evaluate('window.invalidated')).toBe(6);

    const section = page.getByTestId('admin-users-table-section');
    await browserExpect(section.getByText('第 1 / 3 页')).toBeVisible();
    await section.getByRole('button').last().click();
    await browserExpect(section.getByText('第 2 / 3 页')).toBeVisible();
    expect(await lastQuery(page)).toEqual({ limit: 20, offset: 20 });
    await choose(page, section.getByRole('combobox').last(), '50');
    await browserExpect(section.getByText('第 1 / 1 页')).toBeVisible();
    expect(await lastQuery(page)).toEqual({ limit: 50, offset: 0 });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('the credit dialog sends the amount and a reason (a default when none is typed); the details sheet reads one account', async () => {
  const { page, errors } = await open();
  try {
    await page.getByTestId('admin-user-credit-u1').click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByText('调整积分', { exact: true })).toBeVisible();
    await browserExpect(dialog).toContainText('当前余额: 120');
    await browserExpect(dialog.getByRole('button', { name: '确认调整' })).toBeDisabled();
    await dialog.getByLabel('增加积分').click();
    await dialog.getByLabel('增加积分').click();
    await dialog.getByPlaceholder('奖励积分、退款等...').fill('活动奖励');
    await dialog.getByRole('button', { name: '确认调整' }).click();
    expect(await calls(page)).toEqual([['adjustUserCredits', { userId: 'u1', amount: 200, reason: '活动奖励' }]]);
    await browserExpect(dialog).toHaveCount(0);

    await page.getByTestId('admin-user-credit-u2').click();
    await browserExpect(dialog).toContainText('当前余额: 0');
    await dialog.getByLabel('减少积分').click();
    await dialog.getByRole('button', { name: '确认调整' }).click();
    expect((await calls(page))[1]).toEqual(['adjustUserCredits', { userId: 'u2', amount: -100, reason: '管理员调整' }]);
    await browserExpect(dialog).toHaveCount(0);

    expect(await page.evaluate('window.detailQueries')).toEqual([]);
    await page.getByTestId('admin-user-detail-u1').click();
    await browserExpect(dialog.getByText('用户详情')).toBeVisible();
    expect(await page.evaluate('window.detailQueries[0]')).toEqual({ userId: 'u1' });
    await browserExpect(dialog).toContainText('阿甲');
    await browserExpect(dialog).toContainText('a@example.com');
    await browserExpect(dialog).toContainText('203.0.113.9');
    const figure = (label: string) => dialog.getByText(label, { exact: true }).locator('xpath=preceding-sibling::p');
    await browserExpect(figure('对话数')).toHaveText('7');
    await browserExpect(figure('消耗积分')).toHaveText('1,234');
    await browserExpect(figure('当前余额')).toHaveText('120');
    await browserExpect(figure('工单数')).toHaveText('2');
    await browserExpect(dialog).toContainText('调整积分');
    await browserExpect(dialog).toContainText('credit_adjust');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
