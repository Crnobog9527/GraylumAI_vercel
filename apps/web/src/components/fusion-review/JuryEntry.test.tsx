/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ entitlements: undefined as unknown }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => <a {...props as object} /> }));
vi.mock('@/trpc/client', () => {
  const query = (data: unknown) => ({ data, isFetching: false, error: null, refetch: vi.fn() });
  return { trpc: { fusionReview: {
    available: { useQuery: () => query({ enabled: true }) },
    mine: { useQuery: () => query([]) }, panel: { useQuery: () => query(undefined) }, estimate: { useQuery: () => query(undefined) },
    start: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) } },
    user: { getEntitlements: { useQuery: () => ({ data: state.entitlements }) } } } };
});
import { JuryEntry } from './JuryEntry';

const report = { available: true, id: '11111111-2222-4333-8444-555555555555' };
beforeEach(() => { state.entitlements = undefined; });

it('tags the entry Gold-only for a plan without the jury, and quotes no credits', () => {
  state.entitlements = { allowFusionReview: false };
  const html = renderToStaticMarkup(<JuryEntry draftId="d" report={report} busy={false} />);
  expect(html).toContain('请评审团审阅报告');
  expect(html).toContain('Gold 专享');
  expect(html).not.toContain('积分');
  expect(html).not.toContain('开始评审');
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
