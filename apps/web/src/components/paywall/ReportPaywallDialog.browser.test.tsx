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
  // Server double. window.plans is the catalog, window.membership the methodMembership answer;
  // window.report is what the report hook reports; window.checkouts records methodCheckout inputs.
  // window.checkoutMode: 'open' (default, window.checkoutUrl), 'hang', 'recovery' or 'error' (window.checkoutError).
  const trpcMock = `
    import {useState} from 'react';
    window.checkouts = [];
    const q = value => ({data: value, isLoading: false, isError: false});
    export const trpc = {
      runtime: {reportAvailable: {useQuery: () => q({enabled: true})}},
      user: {getEntitlements: {useQuery: (_input, options) => {
        if (options?.enabled) window.entitlementReads = (window.entitlementReads ?? 0) + 1;
        const fresh = window.entitlementsFresh !== false;
        return {...q(options?.enabled ? window.entitlements : undefined), isSuccess: Boolean(options?.enabled),
          isFetchedAfterMount: Boolean(options?.enabled) && fresh, isFetching: Boolean(options?.enabled) && !fresh};
      }}},
      settings: {getMembershipPlans: {useQuery: () => window.plansFail ? {data: window.stalePlans, isLoading: false, isError: true}
        : q(window.plans)}},
      payments: {
        methodMembership: {useQuery: () => q(window.membership)},
        methodCheckout: {useMutation: () => {
          const [isPending, setPending] = useState(false);
          return {isPending, mutateAsync: async input => {
            window.checkouts.push(input); window.recordCheckout?.(input); setPending(true);
            try {
              if (window.checkoutMode === 'hang') await new Promise(r => { window.releaseCheckout = r; });
              if (window.checkoutMode === 'error') {
                throw Object.assign(new Error(window.checkoutError.message), {data: {code: window.checkoutError.code}});
              }
              if (window.checkoutMode === 'recovery') return {orderId: 'o1', state: 'recovery_required', url: null};
              return {orderId: 'o1', state: 'open', url: window.checkoutUrl ?? 'https://checkout.stripe.com/c/pay/cs_test_1'};
            } finally { setPending(false); }
          }};
        }},
      },
    };
  `;
  const reportMock = `
    export function useReportGen() {
      return {...window.report, payg: {turnNotices: () => []}, start: () => { window.starts = (window.starts ?? 0) + 1; },
        restart: () => {}, stop: () => {},
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
const ROUTES = { version: 7, card: { enabled: true }, card_cn: { enabled: true },
  wechat_pay: { enabled: false, annualVerified: false }, alipay: { enabled: false, annualVerified: false } };
const ENTRY = { mode: 'test', routes: ROUTES, checkoutReady: true, termsVersion: 'terms-v3', goldFirstMonthEligible: false,
  founder: { total: 50, sold: 0, reserved: 0, available: 50 }, memberships: [] };
const MEMBERSHIP = { executionId: null, refusal: { text: '生成完整报告需要开通会员。', membership: true } };

async function open(setup: Record<string, unknown>, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A real origin, so the page can use sessionStorage; every other request is blocked.
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://paywall.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
    // Stands in for the Stripe-hosted page; nothing leaves the machine.
    if (url.startsWith('https://checkout.stripe.com/')) return route.fulfill({ contentType: 'text/html', body: 'stripe' });
    return route.abort();
  });
  const sent: unknown[] = [];
  sentByPage.set(page, sent);
  await page.exposeFunction('recordCheckout', (input: unknown) => { sent.push(input); });
  await page.goto('http://paywall.test/');
  await page.evaluate(value => { Object.assign(window, value); }, { plans: PLANS, membership: ENTRY, report: MEMBERSHIP, ...setup });
  if (setup.sessionFlag) await page.evaluate(() => sessionStorage.setItem('opc-report-paywall:d:r', 'membership'));
  await page.addScriptTag({ content: code });
  await page.getByRole('button', { name: '生成完整报告' }).click();
  return { page, errors };
}
// Recorded on the test side too: a hand-off to checkout.stripe.com replaces the page and its window.
const sentByPage = new WeakMap<Page, unknown[]>();
const checkouts = async (page: Page) => sentByPage.get(page) ?? [];

it('a membership refusal opens the paywall with server prices, monthly by default, and pays the chosen plan by card', async () => {
  const { page, errors } = await open({});
  try {
    const dialog = page.getByTestId('report-paywall');
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog).toContainText('你的运营策略报告，只差最后一步');
    await browserExpect(dialog).toContainText('$29 / 月起');
    await browserExpect(page.getByRole('radio', { name: /月付/ })).toBeChecked();
    await browserExpect(page.getByTestId('report-paywall-pay')).toContainText('生成我的完整报告 · $29');
    await browserExpect(page.getByTestId('report-paywall-renewal')).toHaveText('每月自动续费 $29，可随时在个人中心取消，取消后用到当期结束。');
    // Owner copy rules: no credit-cost estimate, no model names, no 7-day refund promise, no countdown, no tax amount.
    const text = await dialog.innerText();
    expect(text).not.toMatch(/预计|消耗|模型|7 天|倒计时|首月 \$49|创始|税额/);

    await page.getByText('年付').click();
    await browserExpect(page.getByText('最高省 25%')).toBeVisible();
    await page.getByTestId('paywall-plan-gold').click();
    await browserExpect(page.getByTestId('paywall-plan-gold')).toContainText('比按月付 12 个月省 $207');
    await browserExpect(page.getByTestId('report-paywall-pay')).toContainText('$621');

    // Unticked terms: no purchase possible.
    await browserExpect(page.getByTestId('report-paywall-terms')).not.toBeChecked();
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    await page.getByTestId('report-paywall-terms').check();

    await page.evaluate(() => { Object.assign(window, { checkoutMode: 'hang' }); });
    await page.getByTestId('report-paywall-pay').click();
    await page.getByTestId('report-paywall-pay').click({ force: true });
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    await page.evaluate(() => { (window as unknown as { releaseCheckout: () => void }).releaseCheckout(); });
    await browserExpect(page).toHaveURL('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(await checkouts(page)).toEqual([{ itemType: 'membership_plan', itemId: 'gold-plan', billingCycle: 'yearly', offer: 'standard',
      method: 'card', routingVersion: 7, acceptedTerms: true, termsVersion: 'terms-v3' }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('shows each card method with its own tax line and sends the mainland card when chosen', async () => {
  const { page, errors } = await open({});
  try {
    await browserExpect(page.getByTestId('report-paywall-method-card')).toContainText('国际银行卡');
    await browserExpect(page.getByTestId('report-paywall-tax')).toHaveText('税另计，结账时按所在地计算');
    await browserExpect(page.getByTestId('report-paywall-method-card_cn')).toContainText('仅限中国大陆用户');
    await page.getByTestId('report-paywall-method-card_cn').click();
    await browserExpect(page.getByTestId('report-paywall-tax')).toHaveText('不另收税');
    await page.getByTestId('report-paywall-terms').check();
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
    expect(await checkouts(page)).toMatchObject([{ method: 'card_cn', itemId: 'pro-plan', billingCycle: 'monthly' }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('shows no card entry until the server says checkout is ready and terms are published', async () => {
  for (const membership of [{ ...ENTRY, checkoutReady: false }, { ...ENTRY, termsVersion: null }]) {
    const { page, errors } = await open({ membership });
    try {
      await browserExpect(page.getByTestId('report-paywall-closed')).toHaveText('银行卡付款暂未开放，请稍后再来。');
      await browserExpect(page.getByTestId('report-paywall-pay')).toHaveCount(0);
      await browserExpect(page.getByTestId('report-paywall-terms')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 30000);

it('keeps the pay button disabled when the plan is not ready to sell', async () => {
  const notReady = [plan('pro', 29, 279, false), plan('gold', 69, 621, false)];
  const { page, errors } = await open({ plans: notReady });
  try {
    await page.getByTestId('report-paywall-terms').check();
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    await browserExpect(page.getByText('这个方案暂不可购买，请稍后再试或换一个方案。')).toBeVisible();
    expect(await checkouts(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('refuses to follow a payment address that is not checkout.stripe.com', async () => {
  const { page, errors } = await open({ checkoutUrl: 'https://checkout.stripe.com.evil.test/pay' });
  try {
    await page.getByTestId('report-paywall-terms').check();
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page.getByTestId('report-paywall-outcome')).toContainText('付款页面地址异常，已停止跳转');
    await browserExpect(page).toHaveURL('http://paywall.test/');
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('sends the user to billing records instead of buying again when the old payment page is gone', async () => {
  const { page, errors } = await open({ checkoutMode: 'recovery' });
  try {
    await page.getByTestId('report-paywall-terms').check();
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page.getByTestId('report-paywall-outcome')).toContainText('请不要重新下单，稍后到个人中心的账单记录查看');
    await browserExpect(page).toHaveURL('http://paywall.test/');
    await browserExpect(page.getByTestId('report-paywall-pay')).toBeDisabled();
    expect(await checkouts(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('shows business refusals in the server words and outages as one generic line', async () => {
  const cases: Array<[string, string, string]> = [
    ['PRECONDITION_FAILED', '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。', '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。'],
    ['CONFLICT', '你有一笔付款还在处理中，请先完成它，或等它超时关闭后再试。', '你有一笔付款还在处理中，请先完成它，或等它超时关闭后再试。'],
    ['FORBIDDEN', '账号已停用或正在注销，不能购买。', '账号已停用或正在注销，不能购买。'],
    ['BAD_REQUEST', '这个优惠不适用于所选套餐，请刷新页面后重试。', '这个优惠不适用于所选套餐，请刷新页面后重试。'],
    ['TOO_MANY_REQUESTS', 'Too many', '下单太频繁了，请稍等一分钟再试。'],
    ['SERVICE_UNAVAILABLE', 'internal reason', '暂时无法创建付款，请稍后查看原订单状态'],
  ];
  for (const [code, message, shown] of cases) {
    const { page, errors } = await open({ checkoutMode: 'error', checkoutError: { code, message } });
    try {
      await page.getByTestId('report-paywall-terms').check();
      await page.getByTestId('report-paywall-pay').click();
      await browserExpect(page.getByRole('alert')).toHaveText(shown);
      await browserExpect(page.getByTestId('report-paywall-pay')).toBeEnabled();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 60000);

it('offers Gold at $49 for the first month when eligible, and switches to the standard price after a refusal', async () => {
  const { page, errors } = await open({ membership: { ...ENTRY, goldFirstMonthEligible: true }, checkoutMode: 'error',
    checkoutError: { code: 'PRECONDITION_FAILED', message: 'Gold 首月优惠仅限首次购买 Gold 的账号，你的账号不符合条件。' } });
  try {
    await page.getByTestId('paywall-plan-gold').click();
    await browserExpect(page.getByTestId('paywall-plan-gold')).toContainText('$49首月');
    await browserExpect(page.getByTestId('paywall-plan-gold')).toContainText('之后每月 $69');
    await browserExpect(page.getByTestId('report-paywall-renewal')).toHaveText('首月 $49，之后每月自动续费 $69，可随时在个人中心取消，取消后用到当期结束。');
    await page.getByTestId('report-paywall-terms').check();
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page.getByRole('alert')).toContainText('Gold 首月优惠仅限首次购买 Gold 的账号');
    await page.getByRole('button', { name: '改按标准价购买' }).click();
    await browserExpect(page.getByTestId('report-paywall-pay')).toContainText('$69');
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => { Object.assign(window, { checkoutMode: 'open' }); });
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
    const sent = await checkouts(page) as Array<{ offer: string; itemId: string }>;
    expect(sent.map(item => [item.itemId, item.offer])).toEqual([['gold-plan', 'gold_first30'], ['gold-plan', 'standard']]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('shows only the switched-on card: mainland only hides the international card, and the reverse', async () => {
  const onlyCn = { ...ENTRY, routes: { ...ROUTES, card: { enabled: false } } };
  const { page, errors } = await open({ membership: onlyCn });
  try {
    await browserExpect(page.getByTestId('report-paywall-method-card_cn')).toBeVisible();
    await browserExpect(page.getByTestId('report-paywall-method-card')).toHaveCount(0);
    await browserExpect(page.getByTestId('report-paywall-tax')).toHaveText('不另收税');
    await page.getByTestId('report-paywall-terms').check();
    await page.getByTestId('report-paywall-pay').click();
    await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
    expect(await checkouts(page)).toMatchObject([{ method: 'card_cn' }]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
  const onlyCard = { ...ENTRY, routes: { ...ROUTES, card_cn: { enabled: false } } };
  const second = await open({ membership: onlyCard });
  try {
    await browserExpect(second.page.getByTestId('report-paywall-method-card')).toBeVisible();
    await browserExpect(second.page.getByTestId('report-paywall-method-card_cn')).toHaveCount(0);
    expect(second.errors).toEqual([]);
  } finally { await second.page.close(); }
}, 30000);

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
    await page.getByTestId('report-paywall-method-card_cn').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The card methods, terms and pay button stay inside the phone width.
    for (const id of ['report-paywall-method-card', 'report-paywall-method-card_cn', 'report-paywall-terms', 'report-paywall-pay']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
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

it('hides the pay button when a catalog refetch failed, even with older prices still cached', async () => {
  const { page, errors } = await open({ plansFail: true, stalePlans: PLANS });
  try {
    await browserExpect(page.getByText('暂时读不到会员方案，请稍后再试。', { exact: false })).toBeVisible();
    await browserExpect(page.getByTestId('report-paywall-pay')).toHaveCount(0);
    expect(await checkouts(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('a round whose Skill cannot write a report gets the plain refusal, never the paywall', async () => {
  // #755: the server checks report support before membership, so this round answers REPORT_MANIFEST_REQUIRED.
  const { page, errors } = await open({ report: { executionId: null,
    refusal: { text: '这个定位流程暂时不支持生成完整报告。' } } });
  try {
    await browserExpect(page.getByRole('dialog', { name: '完整运营策略报告' })).toContainText('这个定位流程暂时不支持生成完整报告。');
    await browserExpect(page.getByTestId('report-paywall')).toHaveCount(0);
    expect(await checkouts(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('does not promise follower-count stages the report does not use', async () => {
  const { page, errors } = await open({});
  try {
    const text = await page.getByTestId('report-paywall').innerText();
    expect(text).toContain('满足什么条件再进入下一步');
    expect(text).not.toMatch(/粉丝到多少|粉丝量/);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('coming back to the page after a membership refusal shows the paywall again without a new start', async () => {
  // A fresh page load (e.g. browser back from checkout): no refusal in memory, only this tab's flag.
  const { page, errors } = await open({ sessionFlag: true, entitlements: { level: 'free' },
    report: { executionId: null, refusal: null, offer: 'start' } });
  try {
    await browserExpect(page.getByTestId('report-paywall')).toBeVisible();
    expect(await page.evaluate('window.starts ?? 0')).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('drops the remembered paywall once the server reports a paid member', async () => {
  const { page, errors } = await open({ sessionFlag: true, entitlements: { level: 'pro' },
    report: { executionId: null, refusal: null, offer: 'start' } });
  try {
    await browserExpect(page.getByRole('dialog', { name: '完整运营策略报告' })).toBeVisible();
    await browserExpect(page.getByTestId('report-paywall')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('opc-report-paywall:d:r'))).toBeNull();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

it('remembers a membership refusal in this tab, and never reads membership without one', async () => {
  const { page, errors } = await open({});
  try {
    await browserExpect(page.getByTestId('report-paywall')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('opc-report-paywall:d:r'))).toBe('membership');
    await page.close();
    const second = await open({ report: { executionId: null, refusal: null, offer: 'start' } });
    expect(await second.page.evaluate('window.entitlementReads ?? 0')).toBe(0);
    await browserExpect(second.page.getByTestId('report-paywall')).toHaveCount(0);
    expect([...errors, ...second.errors]).toEqual([]);
    await second.page.close();
  } finally { if (!page.isClosed()) await page.close(); }
}, 30000);

it('keeps the remembered paywall while only a cached paid level is known', async () => {
  // A cached `pro` from before an expiry, while the fresh read is still running: must not clear the flag.
  const { page, errors } = await open({ sessionFlag: true, entitlements: { level: 'pro' }, entitlementsFresh: false,
    report: { executionId: null, refusal: null, offer: 'start' } });
  try {
    await browserExpect(page.getByTestId('report-paywall')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('opc-report-paywall:d:r'))).toBe('membership');
    expect(await page.evaluate('window.starts ?? 0')).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);
