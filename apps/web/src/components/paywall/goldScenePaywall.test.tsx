/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { features: { useQuery: () => ({ data: undefined }) } } } }));
vi.mock('@/lib/profile-tabs', () => ({ profileTabHref: (tab: string) => `/app/profile?tab=${tab}` }));
vi.mock('./MethodCheckoutForm', () => ({ MethodCheckoutForm: () => <div data-testid="checkout-form" /> }));
import { ReportPaywallView, type PaywallCheckout } from './ReportPaywallDialog';
import { GOLD_SCENE_COPY, GOLD_SCENE_DELIVERABLES, goldSceneCopy } from './goldScenePaywallCopy';
import { fusionPlanLevel } from './paywallPlans';

const plan = (level: 'pro' | 'gold', monthly: number) => ({ id: level + '-id', name: level === 'pro' ? 'Pro 会员' : 'Gold 会员', level,
  price: { monthly, yearly: monthly * 10 }, credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
  // As the plan catalog sends them: today only Gold carries the jury and the model comparison.
  allowFusionReview: level === 'gold', allowFusionCompare: level === 'gold' });
const checkout = {
  plans: [plan('pro', 29), plan('gold', 59)], loading: false, catalogFailed: false, unpaidSubscription: false, quoteOptions: {},
  founderSeats: 0, founderSoldOut: false, method: { pending: false, entry: null, methodsFor: () => [] },
  purchaseFor: () => ({ itemType: 'membership_plan', itemId: 'gold-id', billingCycle: 'monthly', offer: 'standard' }),
  declineFirstMonth: () => {}, markFounderSoldOut: () => {}, declineFounder: () => {},
} as unknown as PaywallCheckout;

it('a Gold-only scene offers only Gold and its own words; the report scene is unchanged', () => {
  for (const scene of ['compare', 'jury'] as const) {
    const html = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene={scene} />);
    expect(html).toContain(GOLD_SCENE_COPY[scene].title);
    expect(html).toContain('value="gold"');
    expect(html).not.toContain('value="pro"');
    expect(html).not.toContain('运营策略报告');
    expect(html).not.toContain('HawkSEM');
  }
  const report = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} />);
  expect(report).toContain('value="pro"');
  expect(report).toContain('value="gold"');
  expect(report).toContain('生成你的完整运营策略报告');
});

it('Gold-scene copy follows the paywall copy rules: no predicted credit cost, no model names, no refund promise', () => {
  const text = JSON.stringify([GOLD_SCENE_COPY, GOLD_SCENE_DELIVERABLES]);
  expect(text).not.toMatch(/预计|消耗|积分|Claude|GPT|Gemini|Opus|Sonnet|退款/);
});

it('a Pro member (or an account not yet known) is sent to the subscription page to upgrade, never sold a plain new Gold order inline', () => {
  for (const memberLevel of ['pro', 'unknown', 'loading']) {
    const html = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene="compare" memberLevel={memberLevel} />);
    expect(html).toContain('paywall-upgrade-via-subscription');
    expect(html).not.toContain('checkout-form');
    expect(html).not.toContain('name="paywall-plan"');
  }
  const html = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene="compare" memberLevel="pro" />);
  expect(html).toContain('/app/profile?tab=subscription');
  const free = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene="compare" memberLevel="free" />);
  expect(free).toContain('checkout-form');
});

// Owner 2026-11-12 (the rail's 多模型对比 and 评审团 entries): the paywall says which plan the tool needs from the plan catalog's own
// entitlement switches, never from a fixed "Gold"; while the catalog does not say, it names no plan.
it('names the plan that carries the tool, by the catalog', () => {
  expect(fusionPlanLevel(checkout.plans, 'compare')).toBe('gold');
  expect(fusionPlanLevel(checkout.plans, 'jury')).toBe('gold');
  const proToo = { ...checkout, plans: checkout.plans.map(item => ({ ...item, allowFusionCompare: true })) } as unknown as PaywallCheckout;
  expect(fusionPlanLevel(proToo.plans, 'compare')).toBe('pro');
  const html = renderToStaticMarkup(<ReportPaywallView checkout={proToo} onClose={() => {}} scene="compare" />);
  expect(html).toContain('开通 Pro，使用多模型对比');
  expect(html).toContain('多模型对比 · Pro 专享');
  // Every plan that carries the tool can be bought for it.
  expect(html).toContain('value="pro"');
  expect(html).toContain('value="gold"');
  // The jury is still Gold's alone in this catalog.
  const jury = renderToStaticMarkup(<ReportPaywallView checkout={proToo} onClose={() => {}} scene="jury" />);
  expect(jury).toContain('开通 Gold，请评审团审阅报告');
  expect(jury).not.toContain('value="pro"');
});

it('names no plan while the catalog does not say which one carries the tool', () => {
  const silent = { ...checkout, plans: checkout.plans.map(item => ({ ...item, allowFusionReview: undefined, allowFusionCompare: undefined })) } as unknown as PaywallCheckout;
  expect(fusionPlanLevel(silent.plans, 'compare')).toBeNull();
  for (const scene of ['compare', 'jury'] as const) {
    const copy = goldSceneCopy(scene, null);
    expect(JSON.stringify(copy)).not.toMatch(/Gold|Pro/);
    expect(copy.eyebrow).toContain('更高级别会员专享');
    expect(copy.title).toContain('开通更高级别会员，');
    const html = renderToStaticMarkup(<ReportPaywallView checkout={silent} onClose={() => {}} scene={scene} />);
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.dossierLede);
    const member = renderToStaticMarkup(<ReportPaywallView checkout={silent} onClose={() => {}} scene={scene} memberLevel="pro" />);
    expect(member).toContain('升级到更高级别会员在订阅页完成');
    expect(member).toContain('去订阅页升级到更高级别会员');
  }
});

it('the three things the entry\'s paywall must say are all there: what it is, why upgrade, which plan', () => {
  const html = renderToStaticMarkup(<ReportPaywallView checkout={checkout} onClose={() => {}} scene="jury" memberLevel="free" />).replace(/<[^>]+>/g, ' ');
  expect(html).toContain('让评审团帮你把报告再审一遍');
  expect(html).toContain('开通后你可以');
  for (const [title] of GOLD_SCENE_DELIVERABLES.jury) expect(html).toContain(title);
  expect(html).toContain('评审团 · Gold 专享');
  expect(html).toContain('评审团是 Gold 会员功能');
});
