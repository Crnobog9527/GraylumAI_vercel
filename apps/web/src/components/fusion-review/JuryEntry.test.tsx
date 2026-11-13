/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ entitlements: undefined as unknown, mine: [] as unknown[], plans: undefined as unknown }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => <a {...props as object} /> }));
vi.mock('@/trpc/client', () => {
  const query = (data: unknown) => ({ data, isFetching: false, error: null, refetch: vi.fn() });
  return { trpc: { fusionReview: {
    available: { useQuery: () => query({ enabled: true }) },
    mine: { useQuery: () => query(state.mine) }, panel: { useQuery: () => query(undefined) } },
    user: { getEntitlements: { useQuery: () => ({ data: state.entitlements }) } },
    settings: { getMembershipPlans: { useQuery: () => ({ data: state.plans }) } } } };
});
import { JuryEntry, juryProcessText } from './JuryEntry';

const report = { available: true, id: '11111111-2222-4333-8444-555555555555' };
const plan = (level: string, jury: boolean) => ({ id: level, name: level, level, price: { monthly: level === 'pro' ? 29 : 69, yearly: 0 },
  credits: { monthly: 1, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: false }, allowFusionReview: jury });
beforeEach(() => { state.entitlements = undefined; state.mine = []; state.plans = [plan('pro', false), plan('gold', true)]; });

it('tags the entry Gold-only for a plan without the jury, and quotes no credits', () => {
  state.entitlements = { allowFusionReview: false };
  const html = renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />);
  expect(html).toContain('请评审团审阅报告');
  expect(html).toContain('Gold 专享');
  expect(html).not.toContain('积分');
  expect(html).not.toContain('开始评审');
});

// Owner 2026-11-12: which plan the tool needs comes from the plan catalog's entitlement switches, never a fixed "Gold".
it('names the plan the catalog says carries the jury, and no plan while the catalog cannot be read', () => {
  state.entitlements = { allowFusionReview: false };
  state.plans = [plan('pro', true), plan('gold', true)];
  expect(renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />)).toContain('Pro 专享');
  state.plans = undefined;
  const html = renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />);
  expect(html).toContain('更高级别会员专享');
  expect(html).not.toContain('Gold');
});

it('shows the normal entry for a plan with the jury, and while the plan is still unknown (the server still guards a start)', () => {
  for (const entitlements of [{ allowFusionReview: true }, undefined]) {
    state.entitlements = entitlements;
    const html = renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />);
    expect(html).toContain('请评审团审阅报告');
    expect(html).not.toContain('Gold 专享');
  }
});

it('shows nothing without a formal report', () => {
  expect(renderToStaticMarkup(<JuryEntry draftId="d" report={{ available: false }} busy={false} />)).toBe('');
});

it('a downgraded user keeps the link to a review they already paid for (running, awaiting a choice, or finished)', () => {
  state.entitlements = { allowFusionReview: false };
  for (const [latest, text] of [[{ reviewId: 'r1', state: 'running', awaitingChoice: false }, '评审团正在审阅'],
    [{ reviewId: 'r2', state: 'completed', awaitingChoice: true }, '逐章选择'],
    [{ reviewId: 'r3', state: 'completed', awaitingChoice: false }, '查看上次评审']] as const) {
    state.mine = [latest];
    const html = renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />);
    expect(html).toContain(text);
    expect(html).toContain(`/${latest.reviewId}`);
  }
});

it('FUSION-REVIEW: says a debate round only when the setting allows one (maxRounds 2), never with one round', () => {
  const one = juryProcessText({ reviewers: ['甲', '乙', '丙'], summary: '主审', maxRounds: 1 });
  expect(one).not.toContain('辩论');
  expect(one).toBe('3 位评审（甲、乙、丙）会各自读完你的定位报告、提出修改意见，最后由主审逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。');
  expect(juryProcessText({ reviewers: ['甲'], summary: '主审' })).not.toContain('辩论');
  expect(juryProcessText({ reviewers: ['甲', '乙'], summary: '主审', maxRounds: 2 })).toContain('意见不一的地方再辩论一轮，最后由主审');
});
