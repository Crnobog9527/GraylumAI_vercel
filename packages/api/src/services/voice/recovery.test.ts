/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { recoverVoiceGenerations } from './recovery';

type RpcOut = { data: unknown; error: { message: string } | null };
function admin(candidates: unknown, failFinish = false) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>): Promise<RpcOut> => {
    calls.push([name, args]);
    if (name === 'voice_recovery_candidates') return { data: candidates, error: null };
    if (name === 'voice_generation_finish' && failFinish) return { data: null, error: { message: 'down' } };
    return { data: {}, error: null };
  }) };
}
const finishes = (db: ReturnType<typeof admin>) => db.calls.filter(([name]) => name === 'voice_generation_finish').map(([, args]) => args);

describe('recoverVoiceGenerations', () => {
  it('records an interrupted generation as failed; money is the turn recovery\'s, not this job\'s', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'generating', hasProfile: false }] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, settled: 1 });
    expect(finishes(db)).toEqual([expect.objectContaining({ failure_code: 'VOICE_INTERRUPTED', settled: true, result: null })]);
  });
  it('a version that is not generating any more is only marked settled', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'failed', hasProfile: false }] });
    await recoverVoiceGenerations(db as never);
    expect(finishes(db)).toEqual([expect.objectContaining({ failure_code: null, settled: true })]);
  });
  it('a version of the retired BILL2 path is left alone and counted as waiting', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'generating', hasProfile: false }] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, settled: 0, waiting: 1 });
    expect(finishes(db)).toEqual([]);
  });
  it('an item that errors moves to the back of the queue and fails the run', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'generating', hasProfile: false }] }, true);
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: false, failed: 1 });
    expect(db.calls.map(([name]) => name)).toContain('voice_recovery_touch');
  });
  it('defers what does not fit in the time limit', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'generating', hasProfile: false }] });
    expect(await recoverVoiceGenerations(db as never, { now: () => 0, timeLimitMs: 1000 })).toMatchObject({ deferred: 1, settled: 0 });
  });
});
