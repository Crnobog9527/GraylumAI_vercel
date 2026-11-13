/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The profile center on a phone (639px and below; Owner 2026-11-12, mobile plan A, screen A5 "我的"), in a real browser: the
// real page, the real list (ProfileMobileHub), the real section menu and the app's CSS, with the server calls and the
// cards of each section replaced by a line naming them. What is checked: the address without a tab is the list; a row
// opens its section as a page with a way back; the phone's own back returns to the list; a link straight to a section
// still has a way back; and above 639px the profile center is what it was. PROFILE_MOBILE_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let html = '';
const shots = process.env.PROFILE_MOBILE_SHOTS;
const entry = fileURLToPath(new URL('./__profile_mobile_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../../../', import.meta.url));
const named = (...names: string[]) => `import { createElement } from 'react';\n`
  + names.map(name => `export const ${name} = () => createElement('p', { 'data-card': '${name}' }, '${name}');`).join('\n');
const STUBS: Record<string, string> = {
  // The address is the source of the tab, as in the app: Next keeps useSearchParams in step with pushState, replaceState and back.
  'next/navigation': `
    import { useSyncExternalStore } from 'react';
    const listeners = new Set();
    const tell = () => listeners.forEach(listener => listener());
    for (const name of ['pushState', 'replaceState']) {
      const original = window.history[name].bind(window.history);
      window.history[name] = (...args) => { original(...args); tell(); };
    }
    window.addEventListener('popstate', tell);
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search));
  `,
  '@/trpc/client': `
    export const trpc = {
      user: { getUserProfile: { useQuery: () => ({ data: { id: 'u1', email: 'a@example.test', nickname: '下班后的小王', membership_level: 'free',
        created_at: '2026-01-01' }, isLoading: false, error: null, isFetching: false, refetch() {} }) } },
      credits: { getCreditsSummary: { useQuery: () => ({ data: undefined, isLoading: true, isError: false }) } },
    };`,
  '@/hooks/use-credits': `export const useCreditsBalance = () => ({ credits: 12345, status: 'ready', isLoading: false, error: null, refetch() {} });`,
  '@/hooks/use-banner': `export const useBanner = () => ({ banners: [] });`,
  '@/hooks/use-profile-prefetch': `export const useProfilePrefetch = () => undefined;`,
  '@/lib/supabase': `export const createClient = () => ({ auth: { signOut: async () => { window.signedOut = true; } } });`,
  '@/lib/site-config': `export const buildAppHref = path => '#signed-out' + path;`,
  '@/components/profile/ProfileShell': `import { createElement } from 'react';
    export const ProfileShell = ({ children }) => createElement('div', { style: { background: '#f7f7f7', minHeight: '100vh' } }, children);`,
  '@/components/layout/GlobalBanner': `export default () => null;`,
  '@/components/founder/FounderBadge': `export const FounderBadge = () => null;`,
  '@/components/founder/FounderProfileCard': `export const FounderProfileCard = () => null;`,
  '@/components/profile/PersonalInfoCard': named('UserProfileHeader', 'CreditsAndSubscriptionCards', 'UsageStatsCard', 'QuickActionsCard'),
  '@/components/profile/SubscriptionCard': named('SubscriptionCard', 'CreditStatsCard'),
  '@/components/profile/BillingRecordsCard': `export default () => null;`,
  '@/components/profile/PaymentNoticeInbox': `export const PaymentNoticeInbox = () => null;`,
  '@/components/profile/PaymentDisputeNotice': `export const PaymentDisputeNotice = () => null;`,
  '@/components/profile/CreditRecordsCard': named('CreditRecordsCard'),
  '@/components/profile/SecuritySettingsCard': named('SecuritySettingsCard'),
  '@/components/profile/AccountErasureCard': named('AccountErasureCard'),
  '@/components/profile/DataUseConsentCard': named('DataUseConsentCard'),
  '@/components/profile/dataUseConsentVisibility': `export const DATA_USE_CONSENT_VISIBLE = false;`,
  '@/components/profile/TicketsPanel': `import { createElement } from 'react';
    export default ({ initialView }) => createElement('p', { 'data-card': 'TicketsPanel' }, 'TicketsPanel:' + initialView);`,
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'profile-mobile-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../../globals.css')}; import Page from ${file('./page.tsx')};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'ProfileMobileTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find(item => item.type === 'chunk')?.code ?? '';
  const css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  // One document, served at the page's own address, so the address and the history behave as they do in the app.
  html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${css}</style></head><body><div id="root"></div><script>${code.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(width: number, query = ''): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 780 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => (new URL(route.request().url()).pathname === '/app/profile'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort()));
  await page.goto(`https://profile.test/app/profile${query}`);
  await page.locator('[data-card], [data-testid="profile-hub"]').first().waitFor({ state: 'attached' });
  return { page, errors };
}
const hub = (page: Page) => page.getByTestId('profile-hub');
const card = (page: Page, name: string) => page.locator(`[data-card="${name}"]`);
const tab = (page: Page) => page.evaluate(() => new URLSearchParams(location.search).get('tab'));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const width of [390, 360]) {
  it(`${width}px, no section in the address: the "我的" list, with the account, the balance and the five sections as rows`, async () => {
    const { page, errors } = await open(width);
    try {
      await browserExpect(hub(page)).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/hub-${width}.png`, fullPage: true });
      await browserExpect(hub(page).getByRole('heading', { name: '我的' })).toBeVisible();
      await browserExpect(hub(page)).toContainText('下班后的小王');
      await browserExpect(hub(page)).toContainText('免费版');
      await browserExpect(hub(page)).toContainText('12,345');
      const rows = ['个人资料', '订阅管理', '积分记录', '账户安全', '工单记录'];
      expect(await hub(page).locator('ul').first().getByRole('link').allInnerTexts()).toEqual(rows);
      for (const name of [...rows.map(row => hub(page).locator('ul').first().getByRole('link', { name: row })),
        hub(page).getByRole('button', { name: '在线反馈' }), hub(page).getByRole('button', { name: '退出登录' })]) {
        expect((await name.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      // The section behind the list and the drawer's button are not on screen; nothing scrolls sideways.
      await browserExpect(card(page, 'UserProfileHeader')).toBeHidden();
      await browserExpect(page.getByRole('button', { name: '菜单' })).toBeHidden();
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('a row opens its section as a page with its name and a way back; the back button returns to the list', async () => {
  const { page, errors } = await open(390);
  try {
    await hub(page).locator('ul').first().getByRole('link', { name: '账户安全' }).click();
    expect(await tab(page)).toBe('security');
    await browserExpect(hub(page)).toHaveCount(0);
    await browserExpect(card(page, 'SecuritySettingsCard')).toBeVisible();
    await browserExpect(page.getByRole('heading', { level: 1, name: '账户安全' })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/section-390.png` });
    const back = page.getByRole('button', { name: '返回我的' });
    expect((await back.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await back.click();
    await browserExpect(hub(page)).toBeVisible();
    expect(await tab(page)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('the phone\'s own back gesture, after opening a section from the list, returns to the list (the page is not left)', async () => {
  const { page, errors } = await open(390);
  try {
    await hub(page).getByRole('link', { name: '订阅管理' }).first().click();
    await browserExpect(card(page, 'SubscriptionCard')).toBeVisible();
    await page.goBack();
    await browserExpect(hub(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/app/profile');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('个人资料 opens the profile section, which on a phone is no longer the address without a tab', async () => {
  const { page, errors } = await open(390);
  try {
    await hub(page).getByRole('link', { name: '个人资料' }).click();
    expect(await tab(page)).toBe('profile');
    await browserExpect(card(page, 'UserProfileHeader')).toBeVisible();
    await browserExpect(page.getByRole('heading', { level: 1, name: '个人资料' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('a link straight to a section: the section shows, and back shows the list in place without leaving the page', async () => {
  const { page, errors } = await open(390, '?tab=credits&checkout=done');
  try {
    await browserExpect(card(page, 'CreditRecordsCard')).toBeVisible();
    await browserExpect(hub(page)).toHaveCount(0);
    const before = await page.evaluate(() => history.length);
    await page.getByRole('button', { name: '返回我的' }).click();
    await browserExpect(hub(page)).toBeVisible();
    // Only the tab is taken out of the address; whatever else was in it stays.
    expect(new URL(page.url()).search).toBe('?checkout=done');
    expect(await page.evaluate(() => history.length)).toBe(before);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('在线反馈 opens the ticket form; 退出登录 signs out', async () => {
  const { page, errors } = await open(390);
  try {
    await hub(page).getByRole('button', { name: '在线反馈' }).click();
    expect(await tab(page)).toBe('tickets');
    await browserExpect(card(page, 'TicketsPanel')).toHaveText('TicketsPanel:create');
    await page.getByRole('button', { name: '返回我的' }).click();
    await hub(page).getByRole('button', { name: '退出登录' }).click();
    await page.waitForFunction(() => (window as unknown as { signedOut?: boolean }).signedOut === true && location.hash === '#signed-out/');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('700px (between the phone and the desktop widths): no list and no back row; the section drawer\'s button is there as before', async () => {
  const { page, errors } = await open(700, '?tab=security');
  try {
    await browserExpect(card(page, 'SecuritySettingsCard')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '菜单' })).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '返回我的' })).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('1280px: the profile center is what it was: the section menu on the left, 个人资料 without a tab, no list, no back row', async () => {
  const { page, errors } = await open(1280);
  try {
    await browserExpect(card(page, 'UserProfileHeader')).toBeVisible();
    await browserExpect(hub(page)).toBeHidden();
    await browserExpect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
    await page.getByRole('button', { name: '积分记录' }).click();
    expect(await tab(page)).toBe('credits');
    await browserExpect(card(page, 'CreditRecordsCard')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '返回我的' })).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
