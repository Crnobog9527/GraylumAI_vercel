/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TurnModelReportCard, UnsettledTurnsCard } from './TurnCostReport';

const fixture = vi.hoisted(() => ({ report: undefined as unknown, unsettled: undefined as unknown, absent: undefined as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: { billingReport: {
  turnByModel: { useQuery: () => ({ data: fixture.report, error: null }) },
  unsettledTurns: { useQuery: () => ({ data: fixture.unsettled, error: null }) },
  absentRefunds: { useQuery: () => ({ data: fixture.absent, error: null }) },
} } }));

function report(unknown: number) {
  return { available: true,
    models: [{ model: 'test/model', calls: 3, unknownCostCalls: unknown, unknownActualCalls: unknown ? 2 : 0, nominalUsd: '0.5', actualUsd: '0.4', minMultiplier: '2', maxMultiplier: '3' }],
    byDate: [{ date: '2026-10-03', calls: 3, unknownCostCalls: unknown, nominalUsd: '0.5' }],
    totals: { calls: 3, unknownCostCalls: unknown, unknownActualCalls: unknown ? 2 : 0, nominalUsd: '0.5', actualUsd: '0.4', turns: 2, chargedCredits: 9, absorbedCredits: 1, unsettledTurns: 1 } };
}

describe('turn cost report cards', () => {
  it('shows a cost with unknown calls as unknown with its known part, in every line', () => {
    fixture.report = report(1);
    const html = renderToStaticMarkup(<TurnModelReportCard />);
    expect(html.match(/未知（已知部分 \$0\.5）/g)).toHaveLength(3); // nominal: model, total, date line
    expect(html.match(/未知（已知部分 \$0\.4）/g)).toHaveLength(2); // actual (counted apart): model line and total
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
  it('lists the calls refunded because the provider said "no such generation", and says when there are none or the list is unavailable', () => {
    fixture.unsettled = { available: true, total: 0, turns: [] };
    fixture.absent = { available: true, total: 1, calls: [{ turnId: 2024, seq: 1, actorId: 'a', kind: 'mentor', providerId: 'gen-1793677834-x', httpStatus: 404,
      settledAt: '2026-11-04T04:00:00Z', openedAt: '2026-11-03T03:50:33Z', reservedCredits: 864, chargedCredits: 0, settlement: 'done', state: 'closed' }] };
    let html = renderToStaticMarkup(<UnsettledTurnsCard />);
    expect(html).toContain('供应商查无而自动退还的调用');
    expect(html).toContain('2024'); expect(html).toContain('gen-1793677834-x'); expect(html).toContain('HTTP 404（查无）');
    expect(html).not.toContain('<button');
    fixture.absent = { available: true, total: 0, calls: [] };
    expect(renderToStaticMarkup(<UnsettledTurnsCard />)).toContain('还没有这类调用');
    fixture.absent = { available: false };
    html = renderToStaticMarkup(<UnsettledTurnsCard />);
    expect(html).toContain('列表暂不可用'); expect(html).not.toContain('还没有这类调用');
  });
});
