import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const componentState = vi.hoisted(() => ({
  plansQuery: {} as Record<string, unknown>,
  membershipQuery: {} as Record<string, unknown>,
  eligibilityQuery: { data: { entries: [] }, isLoading: false } as Record<string, unknown>,
  packagesQuery: {} as Record<string, unknown>,
  entitlementsQuery: { data: { level: 'pro' }, isError: false } as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/trpc/client', () => {
  const mutation = () => ({ mutateAsync: vi.fn() });
  const invalidate = vi.fn();

  return {
    trpc: {
      useUtils: () => ({
        user: { getUserProfile: { invalidate }, getEntitlements: { invalidate } },
        payments: { methodMembership: { invalidate }, getMembershipEligibilityMatrix: { invalidate }, listBillingRecords: { invalidate } },
      }),
      user: { getEntitlements: { useQuery: () => componentState.entitlementsQuery } },
      settings: {
        getMembershipPlans: { useQuery: () => componentState.plansQuery },
        getCreditPackages: { useQuery: () => componentState.packagesQuery },
      },
      payments: {
        methodMembership: { useQuery: () => componentState.membershipQuery },
        getMembershipEligibilityMatrix: { useQuery: () => componentState.eligibilityQuery },
        methodCheckout: { useMutation: mutation },
        getSubscriptionManagement: { useQuery: () => ({ data: { available: true } }) },
        createCustomerPortalSession: { useMutation: mutation },
        syncCheckoutSession: { useMutation: mutation },
      },
    },
  };
});

import { CreditPackagesSection, ProfileCatalogState, SubscriptionCard } from './SubscriptionCard';

const plan = {
  id: 'plan-pro',
  name: 'Pro',
  level: 'pro',
  price: { monthly: 29, yearly: 279 },
  credits: { monthly: 3000, monthlyBonus: 480 },
  discount: 0.05,
  features: ['API plan feature'],
  recommended: true,
  highlight: true,
  checkoutReady: { monthly: true, yearly: true },
};
const ROUTES = { version: 7, card: { enabled: true }, card_cn: { enabled: true },
  wechat_pay: { enabled: false, annualVerified: false }, alipay: { enabled: false, annualVerified: false } };
const ENTRY = { mode: 'test', routes: ROUTES, checkoutReady: true, termsVersion: 'terms-v3', goldFirstMonthEligible: false,
  founder: { total: 50, sold: 50, reserved: 0, available: 0 }, memberships: [] as unknown[] };

function queryState(overrides: Record<string, unknown> = {}) {
  return { data: [], isLoading: false, isError: false, isFetching: false, refetch: vi.fn(), ...overrides };
}

function renderSubscription() {
  return renderToStaticMarkup(createElement(SubscriptionCard, { user: {} }));
}

describe('SubscriptionCard catalog availability', () => {
  beforeEach(() => {
    componentState.entitlementsQuery = { data: { level: 'pro' }, isError: false };
    componentState.packagesQuery = queryState();
    componentState.plansQuery = queryState();
    componentState.membershipQuery = queryState({ data: ENTRY });
  });

  it('renders a successful empty catalog without a published-success message', () => {
    const markup = renderSubscription();
    expect(markup).toContain('当前暂无可用套餐');
    expect(markup).toContain('data-testid="profile-catalog-empty"');
    expect(markup).not.toContain('暂未发布');
  });

  it('renders a retryable unavailable state without a checkout CTA', () => {
    componentState.plansQuery = queryState({ isError: true });
    const markup = renderSubscription();
    expect(markup).toContain('套餐服务暂不可用');
    expect(markup).toContain('重试');
    expect(markup).not.toContain('>开通<');
    expect(markup).not.toContain('$29');
  });

  it('keeps a plan that is not ready visible but without a purchase', () => {
    componentState.plansQuery = queryState({ data: [{ ...plan, checkoutReady: { monthly: false, yearly: false } }] });
    const markup = renderSubscription();
    expect(markup).toContain('Pro');
    expect(markup).toContain('$29');
    expect(markup).toContain('暂不可购买');
    expect(markup).not.toContain('>开通<');
  });

  it.each([
    ['checkout not ready', { ...ENTRY, checkoutReady: false }],
    ['no published terms', { ...ENTRY, termsVersion: null }],
    ['real-money mode has no published refund policy page yet', { ...ENTRY, mode: 'live' }],
  ])('shows no purchase entry when %s', (_label, entry) => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.membershipQuery = queryState({ data: entry });
    const markup = renderSubscription();
    expect(markup).toContain('银行卡付款暂未开放');
    expect(markup).not.toContain('>开通<');
    expect(markup).not.toContain('税另计');
  });

  it('pauses purchases when the membership read fails, but keeps subscription management', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.membershipQuery = queryState({ data: undefined, isError: true });
    const markup = renderSubscription();
    expect(markup).toContain('购买入口已暂停');
    expect(markup).not.toContain('>开通<');
    expect(markup).toContain('管理订阅 / 取消续费');
  });

  it('writes the tax rule of each open card method next to the price, never an amount', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    expect(renderSubscription()).toContain('国际银行卡：税另计，结账时按所在地计算；中国大陆银行卡：不另收税');
    componentState.membershipQuery = queryState({ data: { ...ENTRY, routes: { ...ROUTES, card_cn: { enabled: false } } } });
    expect(renderSubscription()).toMatch(/profile-membership-plan-tax-pro"[^>]*>税另计，结账时按所在地计算</);
    componentState.membershipQuery = queryState({ data: { ...ENTRY, routes: { ...ROUTES, card: { enabled: false } } } });
    expect(renderSubscription()).toMatch(/profile-membership-plan-tax-pro"[^>]*>不另收税</);
  });

  it('shows the paid memberships with method and renewal state, and offers Gold as an upgrade', () => {
    componentState.plansQuery = queryState({ data: [plan, { ...plan, id: 'plan-gold', name: 'Gold', level: 'gold',
      price: { monthly: 69, yearly: 621 } }] });
    componentState.membershipQuery = queryState({ data: { ...ENTRY, memberships: [{ id: 'o1', subscription_id: 'sub-pro',
      purchase_membership_level: 'pro', payment_method: 'card_cn', billing_cycle: 'monthly', offer_kind: 'standard',
      entitlement_start: '2026-10-14T12:00:00Z', entitlement_end: '2099-11-14T12:00:00Z', auto_renew: true,
      cancel_at_period_end: false }] } });
    const markup = renderSubscription();
    expect(markup).toContain('Pro · 月付');
    expect(markup).toContain('中国大陆银行卡');
    expect(markup).toContain('自动续费中，本期到 2099-11-14');
    expect(markup).toContain('当前方案');
    expect(markup).toContain('升级到 Gold');
  });

  it('explains an old subscription with an unsuccessful payment and keeps purchases closed (#937)', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.entitlementsQuery = { data: { level: 'free' }, isError: false };
    componentState.eligibilityQuery = { data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'resolvePaymentIssue',
      reasonCode: 'PAYMENT_ATTENTION_REQUIRED', allowed: false }] }, isLoading: false };
    const markup = renderSubscription();
    expect(markup).toContain('data-testid="profile-unpaid-subscription-notice"');
    expect(markup).toContain('href="/profile?tab=tickets"');
    expect(markup).toContain('请先处理旧订阅');
    expect(markup).not.toContain('>开通<');
    componentState.eligibilityQuery = { data: { entries: [] }, isLoading: false };
  });

  it('renders the isolated retry state as a real component', () => {
    const markup = renderToStaticMarkup(createElement(ProfileCatalogState, { status: 'unavailable', onRetry: vi.fn() }));
    expect(markup).toContain('套餐服务暂不可用');
    expect(markup).toContain('重试');
  });

  it.each([0, -1, null, undefined])('blocks invalid plan amounts %j even if the readiness flag is stale', (amount) => {
    componentState.plansQuery = queryState({ data: [{ ...plan, price: { monthly: amount, yearly: amount } }] });
    expect(renderSubscription()).not.toContain('>开通<');
  });

  it.each([0, -1])('disables purchase for a %s dollar credit package', (price) => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 10, bonus_credits: 0, price, checkout_ready: true }] });
    const markup = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(markup).toContain('暂不可购买');
    expect(markup).toContain('disabled=""');
  });

  it('closes credit-pack purchases while card checkout is closed', () => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 990, bonus_credits: 0, price: 9.9,
      checkout_ready: true }] });
    componentState.entitlementsQuery = { data: { level: 'gold' }, isError: false };
    expect(renderToStaticMarkup(createElement(CreditPackagesSection, { checkoutOpen: false }))).toContain('暂不可购买');
    expect(renderToStaticMarkup(createElement(CreditPackagesSection, { checkoutOpen: true }))).toContain('>购买<');
  });

  it('keeps packs closed while the membership waits for its renewal charge (grace keeps access, not packs)', () => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 990, bonus_credits: 0, price: 9.9,
      checkout_ready: true }] });
    componentState.entitlementsQuery = { data: { level: 'pro' }, isError: false };
    const grace = renderToStaticMarkup(createElement(CreditPackagesSection, { renewalGrace: true }));
    expect(grace).toContain('续费完成后可购买');
    expect(grace).toContain('data-testid="profile-credit-packages-renewal-grace"');
    expect(grace).not.toContain('>购买<');
  });

  it('shows a member the discounted price they pay, with the real list price struck through', () => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 100, bonus_credits: 0, price: 1, checkout_ready: true }] });
    componentState.plansQuery = queryState({ data: [{ ...plan, discount: 0.1 }, { ...plan, id: 'plan-gold', level: 'gold', discount: 0.2 }] });
    const member = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(member).toMatch(/data-testid="profile-credit-package-price"[^>]*>\$0\.90<del/);
    expect(member).toContain('<span class="sr-only">原价</span>$1.00</del>');
    componentState.entitlementsQuery = { data: { level: 'free' }, isError: false };
    const free = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(free).toMatch(/data-testid="profile-credit-package-price"[^>]*>\$1\.00<\/div>/);
    expect(free).not.toContain('<del');
  });

  it('free users see packs but cannot buy them, with the members-only notice', () => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 990, bonus_credits: 0, price: 9.9,
      checkout_ready: true }] });
    componentState.entitlementsQuery = { data: { level: 'free' }, isError: false };
    const free = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(free).toContain('开通会员后可购买');
    expect(free).toContain('data-testid="profile-credit-packages-members-only"');
    expect(free).toContain('disabled=""');
    componentState.entitlementsQuery = { data: undefined, isError: true, isFetching: false, refetch: () => undefined };
    const failed = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(failed).toContain('暂时无法确认会员状态');
    expect(failed).toContain('data-testid="profile-credit-packages-entitlement-error"');
    expect(failed).toMatch(/<button[^>]*>重试<\/button>/);
    componentState.entitlementsQuery = { data: { level: 'gold' }, isError: false };
    const gold = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(gold).toContain('>购买<');
    expect(gold).not.toContain('profile-credit-packages-members-only');
  });
});

// Real browser: the SubscriptionCard and CreditStatsCard bundled with a server double.
// window.__pay holds the answers (membership, search, checkout mode) and records what was sent.
describe('membership page in a local browser', () => {
  let browser: Browser;
  let code: string;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
    const { build } = await import(pathToFileURL(vitePath).href);
    const fixtureId = fileURLToPath(new URL('./__pay_mp_browser_fixture__.js', import.meta.url));
    const source = fileURLToPath(new URL('./SubscriptionCard.tsx', import.meta.url));
    const mock = `
      import {useEffect, useState} from 'react';
      const state = window.__pay;
      // window.__payRefetch(): every methodMembership reader re-renders with the current state.membership (a refetch).
      const refetchers = new Set();
      window.__payRefetch = () => refetchers.forEach(fn => fn(n => n + 1));
      const useRefetchable = () => { const [, force] = useState(0);
        useEffect(() => { refetchers.add(force); return () => { refetchers.delete(force); }; }, []); };
      const inv = { invalidate: async () => {} };
      const utils = { user: { getUserProfile: inv, getEntitlements: inv }, credits: { getBalance: inv, getCreditsSummary: inv },
        payments: { methodMembership: inv, getMembershipEligibilityMatrix: inv, listBillingRecords: inv, getSubscriptionManagement: inv } };
      const query = data => ({ data, isLoading: false, isError: false, isFetching: false, refetch() {} });
      const mutation = fn => ({ useMutation: () => { const [isPending, set] = useState(false);
        return { isPending, mutateAsync: async input => { set(true); try { return await fn(input); } finally { set(false); } } }; } });
      export const trpc = { useUtils: () => utils,
        user: { getEntitlements: { useQuery: () => query({ level: state.level }) } },
        credits: { getCreditsSummary: { useQuery: () => query({ totalSpent: 0 }) } },
        settings: { getMembershipPlans: { useQuery: () => query(state.plans) },
          getCreditPackages: { useQuery: () => query(state.packages) } },
        payments: {
          methodMembership: { useQuery: () => { useRefetchable(); return query(state.membership); } },
          getMembershipEligibilityMatrix: { useQuery: () => query({ entries: state.eligibility ?? [] }) },
          methodCheckout: mutation(async input => { state.checkouts.push(input); window.recordCheckout?.(input);
            if (state.checkoutError) throw Object.assign(new Error(state.checkoutError.message), { data: { code: state.checkoutError.code } });
            if (state.recovery) return { orderId: 'o1', state: 'recovery_required', url: null };
            return { orderId: 'o1', state: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_9' }; }),
          getSubscriptionManagement: { useQuery: () => query({ available: false }) },
          createCustomerPortalSession: mutation(async () => ({})),
          syncCheckoutSession: mutation(async input => { state.syncs.push(input); return state.syncResult; }),
        } };
    `;
    const bundle = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
      plugins: [{ name: 'pay-mp-mocks', enforce: 'pre', resolveId(id: string) {
        if (id === fixtureId) return id;
        if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0pay-mp-trpc';
        if (id === 'next/navigation') return '\0pay-mp-navigation';
      }, load(id: string) {
        if (id === '\0pay-mp-trpc') return mock;
        if (id === '\0pay-mp-navigation') return `export const useRouter = () => ({ push() {}, replace() {} });
          export const useSearchParams = () => new URLSearchParams(window.__pay.search ?? '');`;
        if (id === fixtureId) return `import React from 'react'; import { createRoot } from 'react-dom/client';
          import { SubscriptionCard, CreditStatsCard } from ${JSON.stringify(source)};
          createRoot(document.getElementById('root')).render(React.createElement('div', null,
            React.createElement(SubscriptionCard, { user: {} }), React.createElement(CreditStatsCard, { user: { credits: 10, subscription_tier: 'pro' } })));`;
      } }], build: { write: false, minify: false, lib: { entry: fixtureId, name: 'PayMpTest', formats: ['iife'] } } });
    const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
    code = output.find((item: { type: string }) => item.type === 'chunk').code;
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  const gold = { ...plan, id: 'plan-gold', name: 'Gold', level: 'gold', recommended: false, highlight: false,
    price: { monthly: 69, yearly: 621 }, credits: { monthly: 8970, monthlyBonus: 0 }, discount: 0.1 };
  const proMember = { id: 'o1', subscription_id: '00000000-0000-4000-8000-0000000000aa', purchase_membership_level: 'pro',
    payment_method: 'card', billing_cycle: 'monthly', offer_kind: 'standard', entitlement_start: '2026-10-14T12:00:00Z',
    entitlement_end: '2099-11-14T12:00:00Z', auto_renew: true, cancel_at_period_end: false };
  const sentByPage = new WeakMap<Page, unknown[]>();

  async function open(setup: Record<string, unknown>, width = 1280) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const sent: unknown[] = [];
    sentByPage.set(page, sent);
    await page.exposeFunction('recordCheckout', (input: unknown) => { sent.push(input); });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.split('?')[0] === 'http://profile.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
      if (url.startsWith('https://checkout.stripe.com/')) return route.fulfill({ contentType: 'text/html', body: 'stripe' });
      return route.abort();
    });
    await page.goto(`http://profile.test/${setup.urlSearch ? `?${setup.urlSearch}` : ''}`);
    await page.evaluate(value => { (window as unknown as { __pay: unknown }).__pay = value; }, {
      plans: [plan, gold], packages: [], membership: ENTRY, level: 'free', checkouts: [], syncs: [], syncResult: {}, ...setup });
    await page.addScriptTag({ content: code });
    return { page, errors };
  }

  it('buys Pro by card after ticking the terms, and hands off only to Stripe', async () => {
    const { page, errors } = await open({});
    try {
      await page.getByTestId('profile-membership-plan-pro').getByRole('button', { name: '开通' }).click();
      const dialog = page.getByTestId('method-checkout-dialog');
      await browserExpect(dialog).toContainText('开通 Pro 月付');
      await browserExpect(page.getByTestId('method-checkout-tax')).toHaveText('税另计，结账时按所在地计算');
      await browserExpect(page.getByTestId('method-checkout-pay')).toBeDisabled();
      await browserExpect(page.getByTestId('method-checkout-refund-link')).toHaveAttribute('href', '/faq');
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL('https://checkout.stripe.com/c/pay/cs_test_9');
      expect(sentByPage.get(page)).toEqual([{ itemType: 'membership_plan', itemId: 'plan-pro', billingCycle: 'monthly', offer: 'standard',
        method: 'card', routingVersion: 7, acceptedTerms: true, termsVersion: 'terms-v3' }]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('clears the ticked terms when a newer terms version arrives, and sends the version that was ticked', async () => {
    const { page, errors } = await open({});
    try {
      await page.getByTestId('profile-membership-plan-pro').getByRole('button', { name: '开通' }).click();
      await page.getByTestId('method-checkout-terms').check();
      await browserExpect(page.getByTestId('method-checkout-pay')).toBeEnabled();
      // methodMembership refetched (staleTime 0) with newly published terms; any re-render shows it.
      await page.evaluate(() => { const win = window as unknown as { __pay: { membership: object }; __payRefetch: () => void };
        win.__pay.membership = { ...win.__pay.membership, termsVersion: 'terms-v4' }; win.__payRefetch(); });
      await browserExpect(page.getByTestId('method-checkout-terms')).not.toBeChecked();
      await browserExpect(page.getByTestId('method-checkout-pay')).toBeDisabled();
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL('https://checkout.stripe.com/c/pay/cs_test_9');
      expect(sentByPage.get(page)).toEqual([expect.objectContaining({ method: 'card', acceptedTerms: true, termsVersion: 'terms-v4' })]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('lets a one-time wallet Pro upgrade to Gold and says it never renewed', async () => {
    const walletPro = { ...proMember, payment_method: 'wechat_pay', payment_channel: 'stripe', auto_renew: false, cancel_at_period_end: true };
    const { page, errors } = await open({ level: 'pro', membership: { ...ENTRY, memberships: [walletPro] } });
    try {
      await browserExpect(page.getByTestId('profile-method-memberships')).toContainText('不自动续费');
      await browserExpect(page.getByTestId('profile-method-memberships')).not.toContainText('已停止续费');
      await page.getByRole('button', { name: '升级到 Gold' }).click();
      await browserExpect(page.getByTestId('method-checkout-dialog')).toContainText('原 Pro 是一次性购买，用到本期结束，不退差价。');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('upgrades a Pro member to Gold as a new Gold checkout that names the Pro subscription', async () => {
    const { page, errors } = await open({ level: 'pro', membership: { ...ENTRY, goldFirstMonthEligible: true, memberships: [proMember] } });
    try {
      await browserExpect(page.getByTestId('profile-method-memberships')).toContainText('自动续费中');
      await browserExpect(page.getByTestId('profile-membership-plan-gold')).toContainText('首月');
      await page.getByRole('button', { name: '升级到 Gold' }).click();
      const dialog = page.getByTestId('method-checkout-dialog');
      await browserExpect(dialog).toContainText('原 Pro 订阅到本期结束后停止续费，不退差价。');
      await browserExpect(dialog).toContainText('首月 $49，之后每月自动续费 $69');
      await page.getByTestId('method-checkout-method-card_cn').click();
      await browserExpect(page.getByTestId('method-checkout-tax')).toHaveText('不另收税');
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
      expect(sentByPage.get(page)).toEqual([{ itemType: 'membership_plan', itemId: 'plan-gold', billingCycle: 'monthly',
        offer: 'gold_first30', transition: 'upgrade', priorSubscriptionId: proMember.subscription_id, method: 'card_cn',
        routingVersion: 7, acceptedTerms: true, termsVersion: 'terms-v3' }]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('switches to the standard Gold price after the server refuses the first month', async () => {
    const { page, errors } = await open({ membership: { ...ENTRY, goldFirstMonthEligible: true },
      checkoutError: { code: 'PRECONDITION_FAILED', message: 'Gold 首月优惠仅限首次购买 Gold 的账号，你的账号不符合条件。' } });
    try {
      await page.getByTestId('profile-membership-plan-gold').getByRole('button', { name: '开通' }).click();
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page.getByRole('alert')).toHaveText(/Gold 首月优惠仅限首次购买/);
      await page.getByRole('button', { name: '改按标准价购买' }).click();
      await browserExpect(page.getByTestId('method-checkout-pay')).toContainText('$69');
      await browserExpect(page.getByTestId('method-checkout-renewal')).toHaveText('每月自动续费 $69，可随时在个人中心取消，取消后用到当期结束。');
      await page.evaluate(() => { (window as unknown as { __pay: { checkoutError: unknown } }).__pay.checkoutError = null; });
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
      expect((sentByPage.get(page) as Array<{ offer: string }>).map(item => item.offer)).toEqual(['gold_first30', 'standard']);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('buys a credit pack by international card only, at the price the pack card showed', async () => {
    // The profile still says pro (CreditStatsCard user), the server entitlement says gold: both card and dialog use gold.
    const { page, errors } = await open({ level: 'gold', membership: { ...ENTRY, memberships: [proMember] },
      packages: [{ id: '00000000-0000-4000-8000-0000000000bb', name: '990 积分', credits: 990, bonus_credits: 0, price: 9.9,
        checkout_ready: true }] });
    try {
      await page.getByRole('button', { name: '购买', exact: true }).click();
      await browserExpect(page.getByTestId('method-checkout-method-card')).toBeVisible();
      await browserExpect(page.getByTestId('method-checkout-method-card_cn')).toHaveCount(0);
      await browserExpect(page.getByTestId('profile-credit-package-price')).toContainText('$8.90');
      await browserExpect(page.getByTestId('method-checkout-pay')).toContainText('$8.90');
      await browserExpect(page.getByTestId('method-checkout-renewal')).toHaveText('一次性付款，不自动续费。');
      await browserExpect(page.getByTestId('method-checkout-refund')).toHaveText(/具体条件见《退款政策》/);
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
      expect(sentByPage.get(page)).toMatchObject([{ itemType: 'credit_package', billingCycle: 'one_time', offer: 'standard', method: 'card' }]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('confirms a paid return and explains a canceled one, with the mainland hint', async () => {
    const paid = await open({ search: 'tab=subscription&checkout=success&session_id=cs_test_ok',
      syncResult: { fulfilledAt: '2026-10-14T00:00:00Z', orderStatus: 'completed' } });
    try {
      await browserExpect(paid.page.getByTestId('profile-checkout-notice')).toHaveText('支付已确认，订单状态已同步到账。');
      expect(await paid.page.evaluate(() => (window as unknown as { __pay: { syncs: unknown[] } }).__pay.syncs))
        .toEqual([{ sessionId: 'cs_test_ok' }]);
      expect(paid.errors).toEqual([]);
    } finally { await paid.page.close(); }
    const canceled = await open({ search: 'tab=subscription&checkout=canceled&session_id=cs_test_no',
      syncResult: { fulfilledAt: null, orderStatus: 'pending', paymentStatus: 'unpaid' } });
    try {
      await browserExpect(canceled.page.getByTestId('profile-checkout-notice'))
        .toHaveText('你已取消本次支付，没有发生扣费。如果你在中国大陆，国际银行卡付款页会提示不支持；请回来改选“中国大陆银行卡”。');
      expect(await canceled.page.evaluate(() => (window as unknown as { __pay: { syncs: unknown[] } }).__pay.syncs))
        .toEqual([{ sessionId: 'cs_test_no', checkoutState: 'canceled' }]);
      expect(canceled.errors).toEqual([]);
    } finally { await canceled.page.close(); }
  }, 30_000);

  it('sells Gold yearly at the founder price with real seats, and falls back to $621 when they sell out at checkout', async () => {
    const { page, errors } = await open({ membership: { ...ENTRY, founder: { total: 50, sold: 49, reserved: 0, available: 1 } },
      checkoutError: { code: 'CONFLICT', message: '创始会员名额已售完。' } });
    try {
      await page.getByRole('radio', { name: '按年' }).click();
      await browserExpect(page.getByTestId('profile-founder-seats')).toHaveText('创始会员 · 还剩 1 个名额（共 50 个）');
      await page.getByTestId('profile-membership-plan-gold').getByRole('button', { name: '开通' }).click();
      const dialog = page.getByTestId('method-checkout-dialog');
      await browserExpect(dialog).toContainText('开通 Gold 创始会员 · 年付');
      await browserExpect(page.getByTestId('method-checkout-pay')).toContainText('$496');
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page.getByTestId('method-checkout-notice')).toHaveText('创始会员名额刚刚售完，已改回 Gold 年付标准价，请看清价格后再付款。');
      await browserExpect(page.getByTestId('method-checkout-pay')).toContainText('$621');
      await browserExpect(dialog).toContainText('开通 Gold 年付');
      await browserExpect(page.getByTestId('profile-founder-seats')).toHaveCount(0);
      await page.evaluate(() => { (window as unknown as { __pay: { checkoutError: unknown } }).__pay.checkoutError = null; });
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page).toHaveURL(/checkout\.stripe\.com/);
      expect((sentByPage.get(page) as Array<{ offer: string }>).map(item => item.offer)).toEqual(['founder', 'standard']);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('opens the offer checkout straight from a landing-page buy link, and only when the plan can be bought', async () => {
    const seats = { total: 50, sold: 37, reserved: 0, available: 13 };
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ search: 'tab=subscription&buy=gold&cycle=monthly', membership: { ...ENTRY, goldFirstMonthEligible: true } }, '首月 $49'],
      [{ search: 'tab=subscription&buy=gold&cycle=yearly', membership: { ...ENTRY, founder: seats } }, '$496'],
      [{ search: 'tab=subscription&buy=gold&cycle=yearly' }, '$621'],
      [{ search: 'tab=subscription&buy=pro&cycle=monthly', level: 'pro', membership: { ...ENTRY, memberships: [proMember] } }, null],
      [{ search: 'tab=subscription&buy=gold&cycle=monthly', membership: { ...ENTRY, checkoutReady: false } }, null],
    ];
    for (const [setup, price] of cases) {
      const { page, errors } = await open({ ...setup, urlSearch: setup.search });
      try {
        if (price) {
          const dialog = page.getByTestId('method-checkout-dialog');
          await browserExpect(dialog).toBeVisible();
          await browserExpect(dialog).toContainText(price);
          if (price === '$621') await browserExpect(dialog).not.toContainText('创始');
          await browserExpect(page.getByTestId('method-checkout-terms')).not.toBeChecked();
        } else {
          await browserExpect(page.getByTestId('profile-membership-plan-gold')).toBeVisible();
          await browserExpect(page.getByTestId('method-checkout-dialog')).toHaveCount(0);
        }
        // The buy params are used once and removed from the address.
        await browserExpect.poll(() => new URL(page.url()).search).not.toContain('buy=');
        expect(sentByPage.get(page)).toEqual([]);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 60_000);

  it('keeps a recovery_required purchase locked after the dialog is closed and reopened', async () => {
    const { page, errors } = await open({ recovery: true });
    try {
      const buy = page.getByTestId('profile-membership-plan-pro').getByRole('button', { name: '开通' });
      await buy.click();
      await page.getByTestId('method-checkout-terms').check();
      await page.getByTestId('method-checkout-pay').click();
      await browserExpect(page.getByTestId('method-checkout-outcome')).toContainText('请不要重新下单');
      await page.keyboard.press('Escape');
      await browserExpect(page.getByTestId('method-checkout-dialog')).toHaveCount(0);
      await buy.click();
      await page.getByTestId('method-checkout-terms').check();
      await browserExpect(page.getByTestId('method-checkout-outcome')).toContainText('请不要重新下单');
      await browserExpect(page.getByTestId('method-checkout-pay')).toBeDisabled();
      expect(sentByPage.get(page)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it('fits a 375px phone: plans and the checkout dialog without horizontal scrolling', async () => {
    const { page, errors } = await open({}, 375);
    try {
      await page.getByTestId('profile-membership-plan-pro').getByRole('button', { name: '开通' }).click();
      await browserExpect(page.getByTestId('method-checkout-dialog')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      for (const id of ['method-checkout-method-card', 'method-checkout-method-card_cn', 'method-checkout-terms', 'method-checkout-pay']) {
        await page.getByTestId(id).scrollIntoViewIfNeeded();
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
