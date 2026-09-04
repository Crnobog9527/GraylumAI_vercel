import { createElement } from 'react';
import { existsSync } from 'node:fs';
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
  it('disables upgrade actions even when the eligibility endpoint proposes a plan change', () => {
    componentState.plansQuery = queryState({ data: [plan] });
    componentState.eligibilityQuery = queryState({ data: { entries: [{ planId: plan.id, billingCycle: 'monthly', action: 'changeSubscriptionPlan', allowed: true, state: 'active' }] } });
    const markup = renderSubscription();
    expect(markup).toContain('暂不支持套餐变更');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('升级套餐');
    expect(markup).toContain('管理订阅 / 取消续费');
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
      expect(await page.getByRole('button', { name: '暂不支持套餐变更' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: '暂不可购买' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: '管理订阅 / 取消续费' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: '立即订阅' }).count()).toBe(0);
    } finally { await browser.close(); }
  }, 30_000);

});
