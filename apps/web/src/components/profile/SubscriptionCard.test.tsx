import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const componentState = vi.hoisted(() => ({
  plansQuery: {} as Record<string, unknown>,
  eligibilityQuery: {} as Record<string, unknown>,
  packagesQuery: {} as Record<string, unknown>,
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
        user: { getUserProfile: { invalidate } },
        payments: {
          getMembershipEligibilityMatrix: { invalidate },
          listBillingRecords: { invalidate },
        },
      }),
      settings: {
        getMembershipPlans: { useQuery: () => componentState.plansQuery },
        getCreditPackages: { useQuery: () => componentState.packagesQuery },
      },
      payments: {
        getMembershipEligibilityMatrix: { useQuery: () => componentState.eligibilityQuery },
        getSubscriptionManagement: { useQuery: () => ({ data: { available: true } }) },
        createCheckoutSession: { useMutation: mutation },
        previewSubscriptionPlanChange: { useMutation: mutation },
        changeSubscriptionPlan: { useMutation: mutation },
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
  price: { monthly: 12.5, yearly: 120 },
  credits: {
    monthly: 1000,
    monthlyBonus: 100,
    yearly: 12000,
    yearlyBonus: 1200,
  },
  features: ['API plan feature'],
  recommended: true,
  highlight: true,
  checkoutReady: { monthly: true, yearly: true },
};

function queryState(overrides: Record<string, unknown> = {}) {
  return {
    data: [],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderSubscription() {
  return renderToStaticMarkup(createElement(SubscriptionCard, { user: {} }));
}

describe('SubscriptionCard catalog availability', () => {
  beforeEach(() => {
    componentState.packagesQuery = queryState();
    componentState.plansQuery = queryState();
    componentState.eligibilityQuery = queryState({ data: { entries: [] } });
  });

  it('renders a successful empty catalog without a published-success message', () => {
    const markup = renderSubscription();

    expect(markup).toContain('当前暂无可用套餐');
    expect(markup).toContain('data-testid="profile-catalog-empty"');
    expect(markup).not.toContain('暂未发布');
    expect(markup).not.toContain('立即订阅');
  });

  it('renders a retryable unavailable state without a checkout CTA', () => {
    componentState.plansQuery = queryState({ isError: true });

    const markup = renderSubscription();

    expect(markup).toContain('套餐服务暂不可用');
    expect(markup).toContain('重试');
    expect(markup).not.toContain('暂未发布');
    expect(markup).not.toContain('立即订阅');
    expect(markup).not.toContain('$12.5');
  });

  it('keeps a Price-missing plan visible but replaces checkout with contact support', () => {
    componentState.plansQuery = queryState({
      data: [{ ...plan, checkoutReady: { monthly: false, yearly: false } }],
    });
    componentState.eligibilityQuery = queryState({
      data: {
        entries: [{
          planId: plan.id,
          billingCycle: 'monthly',
          allowed: true,
          action: 'createCheckoutSession',
          reasonCode: 'ALLOWED',
          safeMessage: '允许操作',
        }],
      },
    });

    const markup = renderSubscription();

    expect(markup).toContain('Pro');
    expect(markup).toContain('12.5');
    expect(markup).toContain('联系我们');
    expect(markup).not.toContain('立即订阅');
  });

  it('renders an ineligible plan with a disabled non-checkout action', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({
      data: {
        entries: [{
          planId: plan.id,
          billingCycle: 'monthly',
          allowed: false,
          action: 'none',
          reasonCode: 'CURRENT_PLAN',
          safeMessage: '当前套餐仍有效',
        }],
      },
    });

    const markup = renderSubscription();

    expect(markup).toContain('当前套餐');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('立即订阅');
  });

  it('disables every plan when eligibility service is unavailable', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({ data: undefined, isError: true });

    const markup = renderSubscription();

    expect(markup).toContain('购买资格暂不可用');
    expect(markup).toContain('已暂停 Checkout');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('立即订阅');
  });

  it('renders the isolated retry state as a real component', () => {
    const markup = renderToStaticMarkup(createElement(ProfileCatalogState, {
      status: 'unavailable',
      onRetry: vi.fn(),
    }));

    expect(markup).toContain('套餐服务暂不可用');
    expect(markup).toContain('重试');
  });
  it('keeps subscription cancellation available when the product catalog fails', () => {
    componentState.plansQuery = queryState({ isError: true });
    componentState.eligibilityQuery = queryState({ data: undefined, isError: true });
    expect(renderSubscription()).toContain('管理订阅 / 取消续费');
  });

  it.each([0, -1, null, undefined])('blocks invalid plan amounts %j even if the readiness flag is stale', (amount) => {
    componentState.plansQuery = queryState({ data: [{ ...plan, price: { monthly: amount, yearly: amount } }] });
    componentState.eligibilityQuery = queryState({ data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'createCheckoutSession', allowed: true }] } });
    expect(renderSubscription()).not.toContain('立即订阅');
  });
  it('renders legal upgrade actions without offering a second subscription Checkout', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({ data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'changeSubscriptionPlan', allowed: true, state: 'active' }] } });
    const markup = renderSubscription();
    expect(markup).toContain('升级套餐');
    expect(markup).not.toContain('立即订阅');
    expect(markup).toContain('管理订阅 / 取消续费');
  });
  it('retains paid rights copy and blocks canceled-renewal upgrades with restoration guidance', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({ data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'none', allowed: false,
      reasonCode: 'RENEWAL_RESTORE_REQUIRED', safeMessage: '请先恢复续费' }] } });
    const markup = renderSubscription();
    expect(markup).toContain('请先恢复续费'); expect(markup).toContain('disabled=""');
    expect(markup).toContain('当前权益保留至到期'); expect(markup).toContain('管理订阅 / 取消续费');
  });
  it.each([0, -1])('disables purchase for a %s dollar credit package', (price) => {
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 10, bonus_credits: 0, price, checkout_ready: true }] });
    const markup = renderToStaticMarkup(createElement(CreditPackagesSection, {}));
    expect(markup).toContain('暂不可购买');
    expect(markup).toContain('disabled=""');
  });

  it.skipIf(!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))('validates disabled plan/package actions and the Portal entry in a local browser', async () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({ data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'changeSubscriptionPlan', allowed: true, state: 'active' }] } });
    componentState.packagesQuery = queryState({ data: [{ id: 'package', name: '积分包', credits: 10, bonus_credits: 0, price: 0, checkout_ready: true }] });
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(renderSubscription() + renderToStaticMarkup(createElement(CreditPackagesSection, {})));
      expect(await page.getByRole('button', { name: '升级套餐' }).isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: '暂不可购买' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: '管理订阅 / 取消续费' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: '立即订阅' }).count()).toBe(0);
    } finally { await browser.close(); }
  }, 30_000);

});


it('runs the actual upgrade preview, explicit confirmation and drift-reconfirmation UI locally', async () => {
  const require = createRequire(import.meta.url);
  const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vitePath).href);
  const fixtureId = fileURLToPath(new URL('./__pay1_browser_fixture__.js', import.meta.url));
  const mockId = '\0pay1-upgrade-trpc';
  const source = fileURLToPath(new URL('./SubscriptionCard.tsx', import.meta.url));
  const mock = `
    const state = window.__pay1 = { previews: [], changes: [], checkouts: [], invalidations: 0, drift: true };
    const inv = { invalidate: async () => { state.invalidations++; } };
    const utils = { user: { getUserProfile: inv }, credits: { getBalance: inv, getCreditsSummary: inv },
      payments: { getMembershipEligibilityMatrix: inv, listBillingRecords: inv, getSubscriptionManagement: inv } };
    const plan = { id: 'plan-gold', name: 'Gold', level: 'gold', price: { monthly: 29.9, yearly: 299 }, features: [], checkoutReady: { monthly: true, yearly: true } };
    const query = data => ({ data, isLoading: false, isError: false, isFetching: false });
    const mutation = fn => ({ useMutation: () => ({ mutateAsync: fn, isPending: false }) });
    export const trpc = { useUtils: () => utils, settings: { getMembershipPlans: { useQuery: () => query([plan]) } }, payments: {
      getMembershipEligibilityMatrix: { useQuery: () => query({ entries: ['monthly','yearly'].map(billingCycle => ({
        planId: 'plan-gold', billingCycle, action: 'changeSubscriptionPlan', allowed: false, reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION' })) }) },
      getSubscriptionManagement: { useQuery: () => query({ available: true }) },
      previewSubscriptionPlanChange: mutation(async input => { state.previews.push(input); return {
        planName: 'Gold', billingCycle: input.billingCycle, amountDue: state.previews.length === 1 ? 18765 : 18766,
        currency: 'usd', annualAmount: 29900, prorationDate: 1788535181, fingerprint: 'a'.repeat(64) }; }),
      changeSubscriptionPlan: mutation(async input => { state.changes.push(input); if (state.drift) { state.drift = false; throw new Error('价格已变化，请重新预览并确认。'); } return { status: 'pending_fulfillment' }; }),
      createCheckoutSession: mutation(async input => { state.checkouts.push(input); throw new Error('unexpected checkout'); }),
      createCustomerPortalSession: mutation(async () => ({})), syncCheckoutSession: mutation(async () => ({}))
    } };
  `;
  const bundle = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') }, oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'pay1-local-mocks', enforce: 'pre', resolveId(id: string) {
      if (id === fixtureId) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return mockId;
      if (id === 'next/navigation') return '\0pay1-navigation';
    }, load(id: string) {
      if (id === mockId) return mock;
      if (id === '\0pay1-navigation') return 'export const useRouter = () => ({ push() {}, replace() {} }); export const useSearchParams = () => new URLSearchParams();';
      if (id === fixtureId) return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { SubscriptionCard } from ${JSON.stringify(source)}; createRoot(document.getElementById('root')).render(React.createElement(SubscriptionCard, { user: {} }));`;
    } }], build: { write: false, minify: false, lib: { entry: fixtureId, name: 'PAY1Test', formats: ['iife'] } } });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  const code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const browser = await chromium.launch({ executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => route.abort()); // No provider/network access in this fixture.
    await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: code });
    await page.getByRole('button', { name: '按年', exact: true }).click({ timeout: 5000 }).catch(error => { throw new Error(pageErrors.join('; ') || String(error)); });
    await page.getByRole('button', { name: '升级套餐', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    expect(await dialog.textContent()).toContain('187.65');
    expect(await dialog.textContent()).toContain('299.00');
    expect(await dialog.textContent()).toContain('年付按全年计费');
    expect(await page.evaluate(() => (window as any).__pay1.changes.length)).toBe(0);
    await page.getByRole('button', { name: '确认付款并升级' }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await page.getByText('价格已变化，请重新预览并确认。').count()).toBe(1);
    await page.getByRole('button', { name: '升级套餐', exact: true }).click();
    await dialog.waitFor(); expect(await dialog.textContent()).toContain('187.66');
    await page.getByRole('button', { name: '确认付款并升级' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const state = await page.evaluate(() => (window as any).__pay1);
    expect(state.previews).toHaveLength(2); expect(state.changes).toHaveLength(2); expect(state.checkouts).toHaveLength(0);
    expect(state.changes[1].expected.amountDue).toBe(18766); expect(state.invalidations).toBeGreaterThanOrEqual(6);
    expect(await page.getByText('升级请求已受理，付款及账单确认后套餐和积分才会更新。请稍后刷新查看。').count()).toBe(1);
  } finally { await browser.close(); }
}, 60_000);
