/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { features: { useQuery: () => ({ data: undefined }) } } } }));
vi.mock('@/lib/profile-tabs', () => ({ profileTabHref: (tab: string) => `/app/profile?tab=${tab}` }));
vi.mock('./MethodCheckoutForm', () => ({ MethodCheckoutForm: () => <div data-testid="checkout-form" /> }));
import { ReportPaywallView, type PaywallCheckout } from './ReportPaywallDialog';
import { GOLD_SCENE_COPY } from './goldScenePaywallCopy';
import { COACH_SCENE_COPY, COACH_SCENE_DELIVERABLES } from './coachScenePaywallCopy';

const plan = (level: 'pro' | 'gold', monthly: number) => ({ id: level + '-id', name: level === 'pro' ? 'Pro 会员' : 'Gold 会员', level,
  price: { monthly, yearly: monthly * 10 }, credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true } });
const checkout = {
  plans: [plan('pro', 29), plan('gold', 59)], loading: false, catalogFailed: false, unpaidSubscription: false, quoteOptions: {},
  founderSeats: 0, founderSoldOut: false, method: { pending: false, entry: null, methodsFor: () => [] },
  purchaseFor: () => ({ itemType: 'membership_plan', itemId: 'gold-id', billingCycle: 'monthly', offer: 'standard' }),
  declineFirstMonth: () => {}, markFounderSoldOut: () => {}, declineFounder: () => {},
} as unknown as PaywallCheckout;

it('the coach scene sells Pro and Gold both, in its own words; the report, compare and jury scenes stay as they were', () => {
  const coach = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene="coach" memberLevel="free" />);
  expect(coach).toContain(COACH_SCENE_COPY.title);
  expect(coach).toContain('value="pro"');
  expect(coach).toContain('value="gold"');
  expect(coach).toContain('checkout-form');
  expect(coach).not.toContain('运营策略报告');
  for (const scene of ['compare', 'jury'] as const) {
    const html = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene={scene} />);
    expect(html).toContain(GOLD_SCENE_COPY[scene].title);
    expect(html).toContain('value="gold"');
    expect(html).not.toContain('value="pro"');
  }
  const report = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} />);
  expect(report).toContain('value="pro"');
  expect(report).toContain('生成你的完整运营策略报告');
});

it('the coach scene copy follows the paywall copy rules: no predicted credit cost, no model names, no refund promise, no "internal"', () => {
  const text = JSON.stringify([COACH_SCENE_COPY, COACH_SCENE_DELIVERABLES]);
  expect(text).not.toMatch(/预计|消耗|积分|Claude|GPT|Gemini|Opus|Sonnet|退款|内部/);
});
