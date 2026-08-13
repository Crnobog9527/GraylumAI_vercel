import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const componentState = vi.hoisted(() => ({
  plansQuery: {} as Record<string, unknown>,
  eligibilityQuery: {} as Record<string, unknown>,
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
      },
      payments: {
        getMembershipEligibilityMatrix: { useQuery: () => componentState.eligibilityQuery },
        createCheckoutSession: { useMutation: mutation },
        changeSubscriptionPlan: { useMutation: mutation },
        syncCheckoutSession: { useMutation: mutation },
      },
    },
  };
});

import { ProfileCatalogState, SubscriptionCard } from './SubscriptionCard';

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
});
