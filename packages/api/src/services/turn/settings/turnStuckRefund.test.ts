/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../lib/logger', () => ({ logger: logs }));

import { refundStuckTurn, STUCK_TURN_ALERT_CODE, stuckTurnScan, StuckTurnRefundError } from './turnStuckRefund';

const db = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) }) as never;
const now = new Date('2026-11-06T04:00:00Z');

describe('stuckTurnScan', () => {
  beforeEach(() => vi.clearAllMocks());
  it('is clean and silent when no turn is stuck', async () => {
    expect(await stuckTurnScan(db({ total: 0, oldestOpenedAt: null }), now)).toEqual({ success: true, available: true, count: 0, oldestAgeHours: 0 });
    expect(logs.error).not.toHaveBeenCalled();
  });
  it('fails and logs a fixed error code with the count and the oldest age', async () => {
    const result = await stuckTurnScan(db({ total: 3, oldestOpenedAt: '2026-11-04T22:00:00Z' }), now);
    expect(result).toEqual({ success: false, available: true, count: 3, oldestAgeHours: 30 });
    expect(logs.error).toHaveBeenCalledWith('billing', STUCK_TURN_ALERT_CODE, { count: 3, oldestAgeHours: 30 });
    expect(STUCK_TURN_ALERT_CODE).toBe('turn_unsettled_over_24h');
  });
  it('treats an unreadable scan as a failure, never as none', async () => {
    expect(await stuckTurnScan(db(null, { code: 'PGRST202' }), now)).toMatchObject({ success: false, available: false });
    expect(await stuckTurnScan(db({ total: 'x' }), now)).toMatchObject({ success: false, available: false });
  });
});

describe('refundStuckTurn', () => {
  const input = { actorId: 'a', turnId: 1, adminId: 'admin', requestId: 'r', reason: null };
  it('writes the audit row after a refund (request id as the row id) and logs, but keeps the refund, when that write fails', async () => {
    const done = { refunded: true, turnId: 1, chargedCredits: 0, reservedCredits: 60, closeKind: 'failed', settlement: 'done', stateBefore: 'running' };
    const rpc = vi.fn(async (name: string) => name === 'turn_admin_refund_all' ? { data: done, error: null } : { data: null, error: { code: 'XX' } });
    expect(await refundStuckTurn({ rpc } as never, { ...input, reason: 'stuck' })).toEqual(done);
    expect(rpc).toHaveBeenLastCalledWith('turn_admin_refund_audit', expect.objectContaining({ p_request_id: 'r', p_admin_id: 'admin',
      p_details: expect.objectContaining({ reason: 'stuck', reservedCredits: 60 }) }));
    expect(logs.error).toHaveBeenCalledWith('billing', 'turn_admin_refund_audit_failed', { turnId: 1, code: 'XX' });
    const refused = db({ refunded: false, reason: 'too_young', turnId: 1 });
    await refundStuckTurn(refused, input);
    expect((refused as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledTimes(1);
  });
  it('passes the arguments through and returns the parsed outcome', async () => {
    const client = db({ refunded: false, reason: 'too_young', turnId: 1 });
    expect(await refundStuckTurn(client, input)).toEqual({ refunded: false, reason: 'too_young', turnId: 1 });
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith('turn_admin_refund_all',
      { p_actor_id: 'a', p_turn_id: 1, p_admin_id: 'admin', p_request_id: 'r', p_reason: null });
  });
  it('throws a coded error for a database refusal and for an unexpected shape', async () => {
    await expect(refundStuckTurn(db(null, { message: 'boom TURN_ADMIN_DENIED' }), input)).rejects.toMatchObject({ code: 'TURN_ADMIN_DENIED' });
    await expect(refundStuckTurn(db(null, { message: 'other', code: 'XX' }), input)).rejects.toBeInstanceOf(StuckTurnRefundError);
    await expect(refundStuckTurn(db({ refunded: 'yes' }), input)).rejects.toMatchObject({ code: 'TURN_REFUND_FAILED' });
  });
});
