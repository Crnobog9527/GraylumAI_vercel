/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TurnModelReportCard, UnsettledTurnsCard } from './TurnCostReport';

const fixture = vi.hoisted(() => ({ report: undefined as unknown, unsettled: undefined as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: { billingReport: {
  turnByModel: { useQuery: () => ({ data: fixture.report, error: null }) },
  unsettledTurns: { useQuery: () => ({ data: fixture.unsettled, error: null }) },
} } }));

function report(unknown: number) {
  return { available: true,
    models: [{ model: 'test/model', calls: 3, unknownCostCalls: unknown, nominalUsd: '0.5', actualUsd: '0.4', minMultiplier: '2', maxMultiplier: '3' }],
    byDate: [{ date: '2026-10-03', calls: 3, unknownCostCalls: unknown, nominalUsd: '0.5' }],
    totals: { calls: 3, unknownCostCalls: unknown, nominalUsd: '0.5', actualUsd: '0.4', turns: 2, chargedCredits: 9, absorbedCredits: 1, unsettledTurns: 1 } };
}

describe('turn cost report cards', () => {
  it('shows a cost with unknown calls as unknown with its known part, in every line', () => {
    fixture.report = report(1);
    const html = renderToStaticMarkup(<TurnModelReportCard />);
    expect(html.match(/未知（已知部分 \$0\.5）/g)).toHaveLength(4);
    expect(html).toContain('2× ~ 3×');
    expect(html).toContain('实扣 9 积分，平台承担 1 积分');
    expect(html).toContain('未结清回合 1 个');
  });
  it('shows a fully known cost as a plain sum', () => {
    fixture.report = report(0);
    const html = renderToStaticMarkup(<TurnModelReportCard />);
    expect(html).not.toContain('未知（已知部分');
    expect(html).toContain('名义费用 $0.5');
  });
  it('an unavailable report is said so, not shown as zero', () => {
    fixture.report = { available: false };
    expect(renderToStaticMarkup(<TurnModelReportCard />)).toContain('报表暂不可用');
  });
  it('lists unsettled turns read-only, says when there are none, and flags an unavailable list', () => {
    fixture.unsettled = { available: true, total: 2, turns: [{ turnId: 7, actorId: 'a', kind: 'chat', state: 'closed', settlement: 'pending',
      closeKind: 'completed', openedAt: 'x', updatedAt: '2026-11-02T00:00:00Z', reservedCredits: 30, chargedCredits: 5, failureCode: null,
      inFlightCalls: 0, costPendingCalls: 1 }] };
    let html = renderToStaticMarkup(<UnsettledTurnsCard />);
    expect(html).toContain('共 2 个，只列出最早的 1 个');
    expect(html).toContain('closed（completed）');
    expect(html).not.toContain('<button');
    fixture.unsettled = { available: true, total: 0, turns: [] };
    expect(renderToStaticMarkup(<UnsettledTurnsCard />)).toContain('当前没有未结清的回合');
    fixture.unsettled = { available: false };
    html = renderToStaticMarkup(<UnsettledTurnsCard />);
    expect(html).toContain('列表暂不可用'); expect(html).not.toContain('当前没有');
  });
});
