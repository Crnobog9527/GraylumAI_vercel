/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const billing = vi.hoisted(() => ({ recoverReceipts: vi.fn(), readRun: vi.fn(), requestCancel: vi.fn(), closeRun: vi.fn(), finalizeRun: vi.fn() }));
vi.mock('../bill2/service', async importOriginal => ({ ...await importOriginal<object>(), authoritativeBilling: () => billing }));
const parsed = vi.hoisted(() => vi.fn((value: unknown) => value));
vi.mock('../runtime/stagingPolicy', () => ({ parseStagingPolicy: parsed, loadStagingPolicy: () => { throw new Error('live admission'); } }));
vi.mock('../runtime/stagingTransport', () => ({ stagingTransport: () => ({}) }));
import { recoverVoiceGenerations } from './recovery';

type RpcOut = { data: unknown; error: { message: string } | null };
function admin(candidates: unknown, scrub: string[] = []) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>): Promise<RpcOut> => {
    calls.push([name, args]);
    if (name === 'voice_recovery_candidates') return { data: candidates, error: null };
    if (name === 'voice_billing_scrub') return { data: scrub.shift() ?? 'done', error: null };
    return { data: {}, error: null };
  }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  billing.recoverReceipts.mockResolvedValue({});
  billing.readRun.mockResolvedValue({ closed: false });
  billing.finalizeRun.mockResolvedValue({ closed: true, state: 'settled' });
});

describe('recoverVoiceGenerations', () => {
  it('settles an interrupted generation and records it as failed', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'generating' }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, settled: 1 });
    // No profile was saved: a confirmed failure, so the user is refunded rather than charged for the lost result.
    expect(billing.closeRun).toHaveBeenCalledWith('r', 'confirmed_failure', expect.objectContaining({ kind: 'confirmed_failure' }));
    expect(billing.requestCancel).not.toHaveBeenCalled();
    expect(db.calls.find(([name]) => name === 'voice_generation_finish')?.[1])
      .toMatchObject({ failure_code: 'VOICE_INTERRUPTED', settled: true, result: null });
  });
  it('a saved profile whose run was never closed is closed as delivered', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'draft', hasProfile: true }], scrubs: [] });
    await recoverVoiceGenerations(db as never);
    expect(billing.closeRun).toHaveBeenCalledWith('r', 'delivered', expect.objectContaining({ kind: 'usable_result' }));
  });
  it('a version marked failed with no saved profile is a confirmed failure, never delivered', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'failed', hasProfile: false }], scrubs: [] });
    await recoverVoiceGenerations(db as never);
    expect(billing.closeRun).toHaveBeenCalledWith('r', 'confirmed_failure', expect.anything());
  });
  it('an item that errors moves to the back of the queue', async () => {
    billing.finalizeRun.mockRejectedValueOnce(new Error('down'));
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v9', runId: 'r', status: 'generating', hasProfile: false }], scrubs: [] });
    await recoverVoiceGenerations(db as never);
    expect(db.calls.find(([name]) => name === 'voice_recovery_touch')?.[1]).toEqual({ p_version_id: 'v9' });
  });
  it('a run whose cost is still pending stays listed for the next day', async () => {
    billing.finalizeRun.mockResolvedValue({ closed: true, state: 'cost_pending' });
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'draft' }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ settled: 0, waiting: 1 });
    expect(db.calls.find(([name]) => name === 'voice_generation_finish')?.[1]).toMatchObject({ settled: false });
  });
  it('a generation that never reached billing is only marked failed', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'generating' }], scrubs: [] });
    await recoverVoiceGenerations(db as never);
    expect(billing.finalizeRun).not.toHaveBeenCalled();
  });
  it('settles the open run of a deleted version, then scrubs it', async () => {
    const db = admin({ generations: [], scrubs: [{ actorId: 'a', runId: 'r', outcome: 'cancelled' }] }, ['waiting', 'done']);
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, scrubbed: 1 });
    expect(billing.requestCancel).toHaveBeenCalledWith('r');
    expect(db.calls.filter(([name]) => name === 'voice_billing_scrub')).toHaveLength(2);
  });
  it('settles with the run\'s frozen binding, never live admission, and looks the receipt up only with one', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'draft', recovery: { id: 'w' } }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, settled: 1 });
    expect(parsed).toHaveBeenCalledWith({ id: 'w' });
    expect(billing.recoverReceipts).toHaveBeenCalledWith('r', { timeoutMs: 2000 });
    billing.recoverReceipts.mockClear();
    await recoverVoiceGenerations(admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'draft', recovery: null }],
      scrubs: [] }) as never);
    expect(billing.recoverReceipts).not.toHaveBeenCalled();
  });
  it('leaves what does not fit the cron window for the next run', async () => {
    let clock = 0;
    billing.finalizeRun.mockImplementation(async () => { clock += 25_000; return { closed: true, state: 'settled' }; });
    const db = admin({ generations: [1, 2, 3].map(n => ({ actorId: 'a', versionId: 'v' + n, runId: 'r' + n, status: 'generating' })),
      scrubs: [{ actorId: 'a', runId: 's' }] });
    expect(await recoverVoiceGenerations(db as never, { now: () => clock })).toMatchObject({ settled: 2, scrubbed: 1, deferred: 1 });
  });
  it('a deleted version that had no profile is refunded, not charged', async () => {
    const db = admin({ generations: [], scrubs: [{ actorId: 'a', runId: 's', outcome: 'confirmed_failure' }] }, ['waiting', 'done']);
    await recoverVoiceGenerations(db as never);
    expect(billing.closeRun).toHaveBeenCalledWith('s', 'confirmed_failure', expect.objectContaining({ kind: 'confirmed_failure' }));
    expect(billing.requestCancel).not.toHaveBeenCalled();
  });
  it('a scrub that errors moves to the back of the queue', async () => {
    const db = admin({ generations: [], scrubs: [{ actorId: 'a', runId: 's', outcome: 'cancelled' }] });
    db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>): Promise<RpcOut> => {
      db.calls.push([name, args]);
      if (name === 'voice_recovery_candidates') return { data: { generations: [], scrubs: [{ actorId: 'a', runId: 's', outcome: 'cancelled' }] }, error: null };
      if (name === 'voice_billing_scrub') return { data: null, error: { message: 'locked' } };
      return { data: {}, error: null };
    });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: false, failed: 1 });
    expect(db.calls.find(([name]) => name === 'voice_scrub_touch')?.[1]).toEqual({ p_run_id: 's' });
  });
  it('alternates the queues: a full generation queue does not starve the scrubs', async () => {
    let clock = 0;
    billing.finalizeRun.mockImplementation(async () => { clock += 12_000; return { closed: true, state: 'settled' }; });
    const db = admin({ generations: [1, 2, 3, 4].map(n => ({ actorId: 'a', versionId: 'v' + n, runId: 'r' + n, status: 'generating' })),
      scrubs: [{ actorId: 'a', runId: 's', outcome: 'cancelled' }] });
    await recoverVoiceGenerations(db as never, { now: () => clock });
    expect(db.calls.some(([name, args]) => name === 'voice_billing_scrub' && args.p_run_id === 's')).toBe(true);
  });
  it('counts a failure without stopping the others', async () => {
    billing.finalizeRun.mockRejectedValueOnce(new Error('down'));
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v1', runId: 'r1', status: 'generating' },
      { actorId: 'a', versionId: 'v2', runId: 'r2', status: 'generating' }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: false, failed: 1, settled: 1 });
  });
});
