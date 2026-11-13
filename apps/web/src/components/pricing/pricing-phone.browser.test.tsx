/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The public pricing page on a phone (under 640px; Owner 2026-11-12, phone plan A: "不要像现在这样，就是生硬地挤压"), in a real
// browser: the real plan cards, comparison table, credit packs and questions with the app's CSS (globals.css, Tailwind), and a
// stand-in for the server. Measured on staging before this change (2026-11-13, 390px): the comparison's three columns shared
// 324px, and the plans' buttons were 36px high. PRICING_PHONE_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let html = '';
const shots = process.env.PRICING_PHONE_SHOTS;
const entry = fileURLToPath(new URL('./__pricing_phone_fixture__.js', import.meta.url));
const src = fileURLToPath(new URL('../../', import.meta.url));
const STUBS: Record<string, string> = {
  '@/trpc/client': `
    const read = data => ({ useQuery: () => ({ data, isError: false, isLoading: false }) });
    export const trpc = { settings: { getPublicOffers: read(undefined) },
      publishMonitor: { features: read({ publish: false, ownData: true, weeklyReview: true }) } };`,
  'next/link': `import { createElement } from 'react'; export default function Link({ prefetch, ...props }) { return createElement('a', props); }`,
};

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const file = (name: string) => JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env': '({})' },
    oxc: { jsx: { runtime: 'automatic' } }, css: { postcss: { plugins: [tailwind({ base: src })] } }, resolve: { alias: { '@': src } },
    plugins: [{ name: 'pricing-phone-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      const path = id.replace(/\.(tsx?|jsx?)$/, '');
      const key = Object.keys(STUBS).find(name => name === id || (name.startsWith('@/') && path.endsWith(name.slice(1))));
      if (key) return `\0stub:${key}`;
    }, load(id: string) {
      if (id.startsWith('\0stub:')) return STUBS[id.slice(6)];
      if (id !== entry) return;
      // The same pieces, in the same order and wrapper, as app/(zh-hans)/pricing/page.tsx; the plans as the public catalog sends them.
      return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import ${file('../../app/globals.css')};
        import light from ${file('../design/light-tokens.module.css')};
        import page from ${file('./pricing-page.module.css')};
        import { PricingPlans } from ${file('./PricingPlans.tsx')};
        import { PricingCreditPacks, PricingFaq, PricingStudio } from ${file('./PricingExtras.tsx')};
        const plan = (level, monthly, yearly, limit) => ({ id: level + '-id', name: level, level, price: { monthly, yearly },
          credits: { monthly: level === 'pro' ? 3480 : 8970, monthlyBonus: 0 }, discount: level === 'pro' ? 0.05 : 0.1,
          checkoutReady: { monthly: true, yearly: true }, positioningProfileLimit: limit,
          allowFusionReview: level === 'gold', allowFusionCompare: level === 'gold', fusionReviewEnabled: true, fusionCompareEnabled: true });
        const plans = [plan('free', 0, 0, 1), plan('pro', 29, 279, 3), plan('gold', 69, 621, 6)];
        const packs = [[990, 9.9], [2990, 29.9], [10990, 99.9]].map(([credits, price], index) => ({ id: 'p' + index, credits, bonus_credits: 0, price }));
        const h = React.createElement;
        createRoot(document.getElementById('root')).render(h('main', { className: light.light, style: { background: '#fafaf9' } },
          h('div', { className: page.pricing },
            h(PricingPlans, { plans, links: { signup: '/login?action=signup', membership: '/app/profile?tab=subscription' } }),
            h(PricingCreditPacks, { packages: packs, plans, failed: false }), h(PricingStudio), h(PricingFaq))));`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'PricingPhoneTest', formats: ['iife'] } },
  });
  const output: { type: string; fileName: string; code?: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find(item => item.type === 'chunk')?.code ?? '';
  const css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${css}</style></head><body><div id="root"></div><script>${code.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 780 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => (new URL(route.request().url()).pathname === '/pricing'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort()));
  await page.goto('https://pricing.test/pricing');
  await page.getByTestId('paywall-compare').waitFor();
  return { page, errors };
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
/** The comparison's visible cells, row by row. */
const rows = (page: Page) => page.getByTestId('paywall-compare').locator('tbody tr').evaluateAll(list => list.map(row =>
  [...row.children].filter(cell => (cell as HTMLElement).getClientRects().length).map(cell => (cell.textContent ?? '').trim()
    || (cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? ''))));

for (const width of [390, 360]) {
  it(`${width}px: the comparison shows one plan at a time, picked by a switch; every row and its words are the table's own`, async () => {
    const { page, errors } = await open(width);
    try {
      const tabs = page.getByRole('tablist', { name: '选择要看的会员档' });
      await ui(tabs).toBeVisible();
      expect(await tabs.getByRole('tab').allInnerTexts()).toEqual(['Pro', 'Gold']);
      for (const tab of await tabs.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Pro first, as in the table's own order: a name and one value per row.
      await ui(tabs.getByRole('tab', { name: 'Pro' })).toHaveAttribute('aria-selected', 'true');
      const pro = await rows(page);
      expect(pro).toEqual([['每月积分', '3,480'], ['定位档案数量', '3 个'], ['查看海外平台自有账号近 30 天作品数据', '有'],
        ['对标账号监控、90 天趋势、每周自动复盘', '没有'], ['多模型专家评审团（审阅运营策略报告）', '没有'], ['多模型对比', '没有'],
        ['积分包', '9.5 折'], ['客服回复', '24 小时内'], ['优先体验内测新功能', '没有']]);
      await tabs.getByRole('tab', { name: 'Gold' }).click();
      const gold = await rows(page);
      expect(gold.map(row => row[0])).toEqual(pro.map(row => row[0]));
      expect(gold.map(row => row[1])).toEqual(['8,970', '6 个', '有', '有', '有', '有', '9 折', '工作时间内 2 小时', '有']);
      if (shots) await page.getByTestId('paywall-compare').screenshot({ path: `${shots}/compare-${width}.png` });
      // A short value sits on one line: nothing in the value column is broken over two.
      const heights = await page.getByTestId('paywall-compare').locator('tbody td:last-child').evaluateAll(cells =>
        cells.filter(cell => (cell as HTMLElement).getClientRects().length).map(cell => Math.round(cell.getBoundingClientRect().height)));
      expect(Math.max(...heights), 'a value wrapped onto a second line').toBeLessThanOrEqual(64);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it(`${width}px: the plans' buttons and the billing switch are thumb-sized; the packs are rows; a question opens from its whole head`, async () => {
    const { page, errors } = await open(width);
    try {
      if (shots) await page.screenshot({ path: `${shots}/pricing-${width}.png`, fullPage: true });
      for (const name of ['免费注册', '开通会员']) for (const button of await page.getByRole('link', { name }).all()) {
        expect((await button.boundingBox())!.height, name).toBeGreaterThanOrEqual(48);
      }
      for (const label of ['月付', '年付']) {
        expect((await page.locator('label', { hasText: label }).first().boundingBox())!.height, label).toBeGreaterThanOrEqual(44);
      }
      // Each credit pack: the amount and its price on one line.
      const pack = page.getByTestId('pricing-credit-packs').locator('div.border').first();
      const [amount, price] = await Promise.all([pack.locator('b').boundingBox(), pack.locator('span').boundingBox()]);
      expect(Math.abs((amount!.y + amount!.height) - (price!.y + price!.height))).toBeLessThanOrEqual(6);
      expect(price!.x).toBeGreaterThan(amount!.x + amount!.width);
      // A question: its head is at least 44px high and opens the answer.
      const question = page.getByTestId('pricing-faq').locator('summary').first();
      expect((await question.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await question.click();
      await ui(page.getByTestId('pricing-faq').locator('details').first().locator('p')).toBeVisible();
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('1280px: the comparison is the whole table, every plan side by side, with no switch', async () => {
  const { page, errors } = await open(1280);
  try {
    await ui(page.getByRole('tablist', { name: '选择要看的会员档' })).toBeHidden();
    const all = await rows(page);
    expect(all[0]).toEqual(['每月积分', '3,480', '8,970']);
    expect(all.every(row => row.length === 3)).toBe(true);
    // The three plan cards stand in one row, as before.
    const tops = await Promise.all(['free', 'pro', 'gold'].map(async level =>
      Math.round((await page.getByTestId(`pricing-plan-${level}`).boundingBox())!.y)));
    expect(new Set(tops).size).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
