/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findStuckPaygCalls, settleStuckCall } from './stuckCalls';
const id = '10000000-0000-4000-8000-000000000001';
const db = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
const call = { callId: id, runId: id, actorId: id, model: 'm', phase: 'fusion_review', upperUsd: '0.1', reservedCredits: 48,
  dispatchedAt: '2026-10-14T05:54:25Z', recoveryDeadline: null, recoveryAttempts: 3, fusionVerdict: null,
  receipts: [{ source: 'response', httpStatus: 403, rejectedReason: 'incomplete_stream', observedAt: '2026-10-14T05:54:32Z' }] };

it('keeps the daily reconciliation failing while any stuck call exists, including beyond the page', async () => {
  expect(await findStuckPaygCalls(db({ total: 0, calls: [] }))).toEqual({ success: true, calls: [], total: 0, truncated: false });
  expect(await findStuckPaygCalls(db({ total: 2, calls: [call] }))).toMatchObject({ success: false, total: 2, truncated: true });
  await expect(findStuckPaygCalls(db(null, { message: 'x' }))).rejects.toThrow('BILL2_STUCK_CALLS_SCAN_FAILED');
  await expect(findStuckPaygCalls(db({ total: 1, calls: [{ ...call, rawBody: 'x' }] }))).rejects.toThrow('BILL2_STUCK_CALLS_SCAN_FAILED');
});

it('settles with a verified decimal cost and a reason; maps refusals without leaking database detail', async () => {
  const input = { callId: id, requestId: id, verifiedCostUsd: '0', reason: '供应商确认没有生成' };
  const result = { callId: id, runId: id, actorId: id, verifiedCostUsd: 0, nominalCostUsd: 0, chargedDelta: 0, runState: 'settled',
    runCharged: 0, actualRestore: 48, creditsBefore: 8630, creditsAfter: 8678, settledAt: '2026-10-14T08:00:00Z',
    executionId: null, executionState: null, auditId: id };
  const ok = db(result);
  expect(await settleStuckCall(ok, id, input)).toEqual(result);
  expect(ok.rpc).toHaveBeenCalledWith('bill2_payg_admin_settle_call', { p_admin_id: id, p_request_id: id, p_call_id: id,
    p_verified_cost_usd: '0', p_reason: '供应商确认没有生成' });
  for (const [message, code] of [['BILL2_ADMIN_SETTLE_DENIED', 'FORBIDDEN'], ['BILL2_ADMIN_SETTLE_NOT_READY', 'CONFLICT'],
    ['BILL2_ADMIN_SETTLE_CONFLICT', 'CONFLICT'], ['private detail', 'SERVICE_UNAVAILABLE']])
    await expect(settleStuckCall(db(null, { message }), id, input)).rejects.toMatchObject({ code });
  for (const bad of [{ verifiedCostUsd: '-1' }, { verifiedCostUsd: '1e3' }, { reason: '  ' }])
    await expect(settleStuckCall(ok, id, { ...input, ...bad })).rejects.toThrow();
});
