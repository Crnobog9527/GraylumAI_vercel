/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { absentRefundCalls, turnModelReport, unsettledTurns } from './turnCostReport';

const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-10-31T00:00:00Z');
const report = {
  models: [{ model: 'example/m', calls: 3, unknownCostCalls: 1, unknownActualCalls: 2, nominalUsd: '0.0123', actualUsd: '0.01', minMultiplier: '1.5', maxMultiplier: '2' }],
  byDate: [{ date: '2026-10-02', calls: 3, unknownCostCalls: 1, nominalUsd: '0.0123' }],
  totals: { calls: 3, unknownCostCalls: 1, unknownActualCalls: 2, nominalUsd: '0.0123', actualUsd: '0.01', turns: 2, chargedCredits: 7, absorbedCredits: 1, unsettledTurns: 1 },
};
const db = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as never;

describe('turn cost report', () => {
  it('passes the window and returns the checked report', async () => {
    const client = db(report);
    const result = await turnModelReport(client, from, to);
    expect(result).toMatchObject({ available: true, totals: { calls: 3, unknownCostCalls: 1, unsettledTurns: 1 } });
    expect((client as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith('turn_admin_model_report',
      { p_from: from.toISOString(), p_to: to.toISOString() });
  });
  it('an unapplied function, an error or a changed shape is "unavailable", never an empty report', async () => {
    expect(await turnModelReport(db(null, { code: '42883' }), from, to)).toMatchObject({ available: false });
    expect(await turnModelReport(db({ ...report, extra: 1 }), from, to)).toMatchObject({ available: false });
    expect(await turnModelReport(db({ ...report, totals: { ...report.totals, nominalUsd: 'NaN' } }), from, to)).toMatchObject({ available: false });
  });
  it('lists the unsettled turns content-free and refuses a malformed row', async () => {
    const turn = { turnId: 5, actorId: '00000000-0000-4000-8000-000000000001', kind: 'chat', state: 'running', settlement: null,
      closeKind: null, openedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:01:00Z', reservedCredits: 30, chargedCredits: null,
      failureCode: null, inFlightCalls: 1, costPendingCalls: 0 };
    expect(await unsettledTurns(db({ total: 1, turns: [turn] }))).toMatchObject({ available: true, total: 1 });
    expect(await unsettledTurns(db({ total: 1, turns: [{ ...turn, body: 'PRIVATE' }] }))).toMatchObject({ available: false });
    expect(await unsettledTurns(db(null, { code: 'XX000' }))).toMatchObject({ available: false });
  });
  it('lists refunded calls, reads a row from the pre-0494 function (no source) as lookup_absent, and refuses a malformed row', async () => {
    const old = { turnId: 2024, seq: 1, actorId: '00000000-0000-4000-8000-000000000001', kind: 'mentor', providerId: 'gen-1', httpStatus: 404,
      settledAt: '2026-11-04T04:00:00Z', openedAt: '2026-11-03T03:50:33Z', reservedCredits: 864, chargedCredits: 0, settlement: 'done', state: 'closed' };
    const none = { ...old, seq: 2, source: 'no_identity_24h', providerId: null, httpStatus: null };
    const before = await absentRefundCalls(db({ total: 1, calls: [old] }));
    expect(before).toMatchObject({ available: true, total: 1, calls: [{ source: 'lookup_absent', providerId: 'gen-1', httpStatus: 404 }] });
    expect(await absentRefundCalls(db({ total: 2, calls: [old, none] }))).toMatchObject({ available: true,
      calls: [{ source: 'lookup_absent' }, { source: 'no_identity_24h', providerId: null, httpStatus: null }] });
    expect(await absentRefundCalls(db({ total: 1, calls: [{ ...old, source: 'other' }] }))).toMatchObject({ available: false });
    expect(await absentRefundCalls(db({ total: 1, calls: [{ ...old, body: 'PRIVATE' }] }))).toMatchObject({ available: false });
  });
});
