/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__report_paywall_fixture__.js', import.meta.url));

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('../../app/positioning/[draftId]/report-panel.tsx', import.meta.url));
  // Server double. window.plans / window.matrix are the catalog and eligibility answers;
  // window.report is what the report hook reports; window.checkouts records purchase requests.
  const trpcMock = `
    import {useState} from 'react';
    window.checkouts = [];
    const q = value => ({data: value, isLoading: false, isError: false});
    export const trpc = {
      runtime: {reportAvailable: {useQuery: () => q({enabled: true})}},
      settings: {getMembershipPlans: {useQuery: () => window.plansFail ? {data: undefined, isLoading: false, isError: true}
        : q(window.plans)}},
      payments: {
        getMembershipEligibilityMatrix: {useQuery: () => q(window.matrix)},
        createCheckoutSession: {useMutation: () => {
          const [isPending, setPending] = useState(false);
          return {isPending, mutateAsync: async input => {
            window.checkouts.push(input); setPending(true);
            try {
              if (window.checkoutMode === 'hang') await new Promise(r => { window.releaseCheckout = r; });
              if (window.checkoutMode === 'fail') throw new Error('当前支付渠道尚未接入，暂不可购买');
              return {checkoutUrl: '#paid', sessionId: 'cs_test'};
            } finally { setPending(false); }
          }};
        }},
      },
    };
  `;
  const reportMock = `
    export function useReportGen() {
      return {...window.report, payg: {turnNotices: () => []}, start: () => {}, restart: () => {}, stop: () => {},
        retryStop: () => {}};
    }
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'report-paywall-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0paywall-trpc';
      if (id === './use-report-gen' || id.endsWith('/use-report-gen')) return '\0paywall-report';
    }, load(id: string) {
      if (id === '\0paywall-trpc') return trpcMock;
      if (id === '\0paywall-report') return reportMock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import {ReportEntry} from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(ReportEntry,
          {draftId: 'd', sessionId: 's', projectId: 'p', roundId: 'r', confirmed: true, busy: false}));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'ReportPaywallTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

const plan = (level: string, monthly: number, yearly: number, ready = true) => ({
  id: level + '-plan', name: level, level, price: { monthly, yearly }, credits: { monthly: level === 'pro' ? 3480 : 8970,
    monthlyBonus: 0 }, discount: level === 'pro' ? 0.05 : 0.1, checkoutReady: { monthly: ready, yearly: ready },
});
const PLANS = [plan('free', 0, 0), plan('pro', 29, 279), plan('gold', 69, 621)];
const entryFor = (planId: string, billingCycle: string, allowed = true) => ({ planId, billingCycle, allowed,
  action: allowed ? 'createCheckoutSession' : 'contactSupport', reasonCode: allowed ? 'OK' : 'BLOCKED',
  safeMessage: allowed ? '' : '当前账号暂时不能购买，请联系客服。' });
const MATRIX = { currentLevel: 'free', entries: ['pro-plan', 'gold-plan'].flatMap(id =>
  [entryFor(id, 'monthly'), entryFor(id, 'yearly')]) };
const MEMBERSHIP = { executionId: null, refusal: { text: '生成完整报告需要开通会员。', membership: true } };

async function open(setup: Record<string, unknown>, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { Object.assign(window, value); }, { plans: PLANS, matrix: MATRIX, report: MEMBERSHIP, ...setup });
  await page.addScriptTag({ content: code });
  await page.getByRole('button', { name: '生成完整报告' }).click();
  return { page, errors };
}
const checkouts = (page: Page) => page.evaluate('window.checkouts');

it('a membership refusal opens the paywall with server prices, monthly by default, and pays the chosen plan', async () => {
  const { page, errors } = await open({});
  try {
    const dialog = page.getByTestId('report-paywall');
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog).toContainText('你的运营策略报告，只差最后一步');
    await browserExpect(dialog).toContainText('$29 / 月起');
    await browserExpect(page.getByRole('radio', { name: /月付/ })).toBeChecked();
    await browserExpect(page.getByTestId('report-paywall-pay')).toContainText('生成我的完整报告 · $29');
    await browserExpect(page.getByTestId('report-paywall-renewal')).toHaveText('每月自动续费 $29，可随时在个人中心取消，取消后用到当期结束。');
    // Owner copy rules: no credit-cost estimate, no model names, no 7-day refund promise, no fake countdown.
    const text = await dialog.innerText();
    expect(text).not.toMatch(/预计|消耗|模型|7 天|退款|倒计时|首月 \$49|创始/);

    await page.getByText('年付').click();
    await browserExpect(page.getByText('最高省 25%')).toBeVisible();
    await page.getByTestId('paywall-plan-gold').click();
    await browserExpect(page.getByTestId('paywall-plan-gold')).toContainText('比按月付 12 个月省 $207');
    await browserExpect(page.getByTestId('report-paywall-pay')).toContainText('$621');

    await page.evaluate(() => { Object.assign(window, { checkoutMode: 'hang' }); });
    await page.getByTestId('report-paywall-pay').click();
    await page.getByTestId('report-paywall-pay').click({ force: true });
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    await page.evaluate(() => { (window as unknown as { releaseCheckout: () => void }).releaseCheckout(); });
    await browserExpect(page).toHaveURL(/#paid$/);
    expect(await checkouts(page)).toEqual([{ kind: 'membership_plan', planId: 'gold-plan', billingCycle: 'yearly' }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('keeps the pay button disabled with the server reason when checkout is not ready or not allowed', async () => {
  const notReady = [plan('pro', 29, 279, false), plan('gold', 69, 621, false)];
  const { page, errors } = await open({ plans: notReady });
  try {
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    await page.close();
    const blocked = { currentLevel: 'free', entries: MATRIX.entries.map(item => entryFor(item.planId, item.billingCycle, false)) };
    const second = await open({ matrix: blocked });
    await browserExpect(second.page.getByTestId('report-paywall-pay')).toBeDisabled();
    await browserExpect(second.page.getByText('当前账号暂时不能购买，请联系客服。')).toBeVisible();
    expect(await checkouts(second.page)).toEqual([]);
    expect([...errors, ...second.errors]).toEqual([]);
    await second.page.close();
  } finally { if (!page.isClosed()) await page.close(); }
}, 30000);

it('shows a checkout failure in plain Chinese and lets the user try again', async () => {
  const { page, errors } = await open({ checkoutMode: 'fail' });
  try {
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page.getByRole('alert')).toHaveText('当前支付渠道尚未接入，暂不可购买');
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('falls back to a calm message when the catalog cannot be read, and closes back to the page', async () => {
  const { page, errors } = await open({ plansFail: true });
  try {
    await browserExpect(page.getByText('暂时读不到会员方案，请稍后再试。', { exact: false })).toBeVisible();
    await browserExpect(page.getByTestId('report-paywall-pay')).toHaveCount(0);
    await page.getByRole('button', { name: '先不开通' }).click();
    await browserExpect(page.getByTestId('report-paywall')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('fits a phone screen without horizontal scrolling', async () => {
  const { page, errors } = await open({}, 375);
  try {
    await browserExpect(page.getByTestId('report-paywall')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('without a membership refusal the normal report dialog opens, not the paywall', async () => {
  const { page, errors } = await open({ report: { executionId: null, refusal: null, offer: 'start' } });
  try {
    await browserExpect(page.getByRole('dialog', { name: '完整运营策略报告' })).toBeVisible();
    await browserExpect(page.getByTestId('report-paywall')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);
