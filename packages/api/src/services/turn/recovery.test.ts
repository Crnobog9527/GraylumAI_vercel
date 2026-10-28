/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TransportObservation } from '../bill2/fixtureAdapter';
import type { RecoveryItem } from './db';
import { RECOVERY_BATCH, recoverTurns, type TurnRecoveryDeps } from './recovery';

// CORE-PATH-V2 V2-8: the turns recovery loop. The database side (claim leases, re-checks under lock, settles once) is the
// turn-core recovery suite; here: lookups become late receipts, nothing unknown is presumed, and the time budget is kept.
const actorId = '00000000-0000-4000-8000-000000000001';
const observed = (body: unknown, httpStatus = 200): TransportObservation => {
  const rawBody = JSON.stringify(body);
  return { rawBody, rawBodyBase64: Buffer.from(rawBody).toString('base64'), sourceHash: createHash('sha256').update(rawBody).digest('hex'),
    httpStatus, complete: true, transportIssue: null } as TransportObservation;
};
const generation = (cost: number) => observed({ data: { id: 'gen-1', model: 'test/model-20261001', finish_reason: 'stop', total_cost: cost,
  native_tokens_prompt: 100, native_tokens_completion: 20 } });
const settle = (turnId: number, calls: RecoveryItem['calls'] = [{ seq: 1, providerId: 'gen-1', model: 'test/model', upperUsd: '0.02' }]):
  RecoveryItem => ({ actorId, turnId, action: 'settle', calls });

function harness(batches: RecoveryItem[][], lookup: TurnRecoveryDeps['lookup'], clock = { t: 0 }) {
  const db = {
    claimRecovery: vi.fn(async () => batches.shift() ?? []),
    recover: vi.fn(async (a: { action: string }) => ({ action: a.action, settlement: 'done' as const, closeKind: 'interrupted' })),
    record: vi.fn(async () => ({ status: 'ok', creditsLow: false, sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false })),
  };
  const deps = { db: db as unknown as TurnRecoveryDeps['db'], lookup, account: 'openrouter-key:synthetic', deadline: 60_000,
    now: () => clock.t };
  return { db, deps };
}

describe('recoverTurns', () => {
  it('interrupts, expires and settles what the claim returns, each through turn_recover', async () => {
    const { db, deps } = harness([[{ actorId, turnId: 1, action: 'interrupt', calls: [] }, { actorId, turnId: 2, action: 'expire', calls: [] }]],
      null);
    const summary = await recoverTurns(deps);
    expect(db.recover.mock.calls.map(c => c[0])).toEqual([{ actorId, turnId: 1, action: 'interrupt' }, { actorId, turnId: 2, action: 'expire' }]);
    expect(summary).toMatchObject({ claimed: 2, interrupted: 1, expired: 1, failed: 0 });
    expect(db.claimRecovery).toHaveBeenCalledWith(RECOVERY_BATCH);
  });

  it('records a cost found by provider id as the late receipt, capped at the frozen bound, then settles once', async () => {
    const lookup = vi.fn(async () => generation(0.5));
    const { db, deps } = harness([[settle(7)]], lookup);
    const summary = await recoverTurns(deps);
    expect(lookup).toHaveBeenCalledWith('gen-1', expect.objectContaining({ model: 'test/model', account: 'openrouter-key:synthetic' }), 2_000);
    expect(db.record).toHaveBeenCalledWith(expect.objectContaining({ turnId: 7, seq: 1, status: 'ok', nominalUsd: '0.02', actualUsd: '0.5',
      providerId: 'gen-1' }));
    expect(db.record.mock.invocationCallOrder[0]).toBeLessThan(db.recover.mock.invocationCallOrder[0]!);
    expect(summary).toMatchObject({ lookups: 1, lateReceipts: 1, settled: 1 });
  });

  it('never presumes an unknown cost: a failed, unfinished or mismatched lookup records nothing', async () => {
    for (const lookup of [vi.fn(async () => { throw new Error('timeout'); }), vi.fn(async () => observed({ error: { code: 500 } }, 500)),
      vi.fn(async () => observed({ data: { id: 'gen-other', model: 'test/model', finish_reason: 'stop', total_cost: 0 } }))]) {
      const { db, deps } = harness([[settle(8)]], lookup);
      const recover = db.recover.mockResolvedValue({ action: 'settle', settlement: 'pending' as never, closeKind: 'interrupted' });
      const summary = await recoverTurns(deps);
      expect(db.record).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledOnce();
      expect(summary).toMatchObject({ lookups: 1, lateReceipts: 0, pending: 1, settled: 0, failed: 0 });
    }
    // Without the platform key nothing is looked up; a late receipt the API already wrote is still settled.
    const { db, deps } = harness([[settle(9)]], null);
    await recoverTurns({ ...deps, account: null });
    expect(db.record).not.toHaveBeenCalled();
    expect(db.recover).toHaveBeenCalledOnce();
  });

  it('keeps going over full batches and stops before the deadline, leaving the rest leased for the next run', async () => {
    const full = (start: number) => Array.from({ length: RECOVERY_BATCH }, (_, i) => ({ actorId, turnId: start + i, action: 'interrupt' as const, calls: [] }));
    const clock = { t: 0 };
    const { db, deps } = harness([full(1), full(100), []], null, clock);
    db.recover.mockImplementation(async (a: { action: string }) => { clock.t += 100; return { action: a.action, settlement: 'done', closeKind: 'interrupted' }; });
    const all = await recoverTurns(deps);
    expect(all.interrupted).toBe(2 * RECOVERY_BATCH);
    expect(db.claimRecovery).toHaveBeenCalledTimes(3);

    const late = harness([full(1)], null, { t: 0 });
    late.db.recover.mockImplementation(async (a: { action: string }) => ({ action: a.action, settlement: 'done', closeKind: 'interrupted' }));
    const stopped = await recoverTurns({ ...late.deps, deadline: 500, now: (() => { let t = 0; return () => (t += 100); })() });
    expect(stopped.interrupted).toBeLessThan(RECOVERY_BATCH);
  });

  it('counts a turn that could not be recovered as failed and carries on', async () => {
    const { db, deps } = harness([[{ actorId, turnId: 1, action: 'interrupt', calls: [] }, { actorId, turnId: 2, action: 'expire', calls: [] }]], null);
    db.recover.mockRejectedValueOnce(new Error('TURN_DATABASE_UNAVAILABLE'));
    const summary = await recoverTurns(deps);
    expect(summary).toMatchObject({ failed: 1, expired: 1 });
  });

  it('counts a turn another instance or a resume already moved as skipped', async () => {
    const { db, deps } = harness([[{ actorId, turnId: 1, action: 'expire', calls: [] }]], null);
    db.recover.mockResolvedValue({ action: 'expire', skipped: true } as never);
    expect(await recoverTurns(deps)).toMatchObject({ skipped: 1, expired: 0 });
  });
});
