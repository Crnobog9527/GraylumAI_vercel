/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const billing = vi.hoisted(() => ({ recoverReceipts: vi.fn(), readRun: vi.fn(), requestCancel: vi.fn(), finalizeRun: vi.fn() }));
vi.mock('../bill2/service', async importOriginal => ({ ...await importOriginal<object>(), authoritativeBilling: () => billing }));
vi.mock('../runtime/stagingPolicy', () => ({ loadStagingPolicy: async () => ({}) }));
vi.mock('../runtime/stagingTransport', () => ({ stagingTransport: () => ({}) }));
import { recoverVoiceGenerations } from './recovery';

function admin(candidates: unknown, scrub: string[] = []) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
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
  billing.finalizeRun.mockResolvedValue({ closed: true });
});

describe('recoverVoiceGenerations', () => {
  it('settles an interrupted generation and records it as failed', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: 'r', status: 'generating' }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, settled: 1 });
    expect(billing.requestCancel).toHaveBeenCalledWith('r');
    expect(db.calls.find(([name]) => name === 'voice_generation_finish')?.[1])
      .toMatchObject({ failure_code: 'VOICE_INTERRUPTED', settled: true, result: null });
  });
  it('a generation that never reached billing is only marked failed', async () => {
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v', runId: null, status: 'generating' }], scrubs: [] });
    await recoverVoiceGenerations(db as never);
    expect(billing.finalizeRun).not.toHaveBeenCalled();
  });
  it('settles the open run of a deleted version, then scrubs it', async () => {
    const db = admin({ generations: [], scrubs: [{ actorId: 'a', runId: 'r' }] }, ['waiting', 'done']);
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: true, scrubbed: 1 });
    expect(billing.requestCancel).toHaveBeenCalledWith('r');
    expect(db.calls.filter(([name]) => name === 'voice_billing_scrub')).toHaveLength(2);
  });
  it('counts a failure without stopping the others', async () => {
    billing.finalizeRun.mockRejectedValueOnce(new Error('down'));
    const db = admin({ generations: [{ actorId: 'a', versionId: 'v1', runId: 'r1', status: 'generating' },
      { actorId: 'a', versionId: 'v2', runId: 'r2', status: 'generating' }], scrubs: [] });
    expect(await recoverVoiceGenerations(db as never)).toMatchObject({ success: false, failed: 1, settled: 1 });
  });
});
