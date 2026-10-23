/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admit: vi.fn(), billing: {} as Record<string, ReturnType<typeof vi.fn>>, text: vi.fn() }));
vi.mock('./admission', () => ({ admitVoiceRun: mocks.admit }));
vi.mock('../bill2/service', async importOriginal => ({ ...await importOriginal<object>(), authoritativeBilling: () => mocks.billing }));
vi.mock('../fusion/executor', () => ({ fusionResponseText: mocks.text }));
vi.mock('../runtime/stagingTransport', () => ({ stagingTransport: () => ({}) }));
import { generateVoiceProfile } from './generation';

const material = [{ documentId: 'd1', filename: 'a.md', text: '哎下班到家都七点了，咋整。\n一口锅搞定呗。' }];
const good = JSON.stringify({ tone: '口语', sentenceLength: '短', openings: '吐槽', stance: '温和', phrases: [], avoid: [],
  platforms: '', samples: ['哎下班到家都七点了，咋整。', '一口锅搞定呗。'] });
function admin(begin: unknown = { replayed: false, version: { id: 'v1' }, material }) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    calls.push([name, args]);
    if (name === 'voice_generation_begin') return { data: begin, error: null };
    if (name === 'voice_generation_finish') return { data: { id: 'v1', status: args.failure_code ? 'failed' : 'draft' }, error: null };
    return { data: null, error: null };
  }) };
}
const deps = (db: ReturnType<typeof admin>) => ({ admin: db as never, actorId: 'a1', budget: { modelCallTimeout: vi.fn() } as never,
  transport: () => ({}) as never, callGate: () => vi.fn(async () => ({ ok: true })) as never });
const finish = (db: ReturnType<typeof admin>) => db.calls.find(([name]) => name === 'voice_generation_finish')?.[1];
const finishes = (db: ReturnType<typeof admin>) => db.calls.filter(([name]) => name === 'voice_generation_finish').map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ runId: 'r1', body: '{}', call: { model: 'm' }, window: {} });
  mocks.text.mockReturnValue(good);
  mocks.billing = {
    claimPaygCall: vi.fn(async () => ({ id: 'c1', state: 'claimed' })),
    dispatchOnce: vi.fn(async () => ({ dispatched: true, observation: {} })),
    closeRun: vi.fn(async () => ({})), finalizeRun: vi.fn(async () => ({ closed: true, state: 'settled' })),
    requestCancel: vi.fn(async () => ({})), recordReceipt: vi.fn(),
  };
});

describe('generateVoiceProfile', () => {
  it('saves the parsed profile after a delivered, settled call', async () => {
    const db = admin();
    expect((await generateVoiceProfile(deps(db), 'r', [])).status).toBe('draft');
    expect(mocks.billing.closeRun).toHaveBeenCalledWith('r1', 'delivered', expect.objectContaining({ kind: 'usable_result' }));
    // Saved first (not yet settled), then marked settled once the run is final.
    expect(finishes(db)).toEqual([expect.objectContaining({ settled: false, result: expect.objectContaining({ tone: '口语' }) }),
      expect.objectContaining({ settled: true, result: null, failure_code: null })]);
    expect(db.rpc.mock.invocationCallOrder[1]).toBeLessThan(mocks.billing.closeRun!.mock.invocationCallOrder[0]!);
  });
  it('keeps the run with the daily recovery while its cost is pending', async () => {
    mocks.billing.finalizeRun!.mockResolvedValue({ closed: true, state: 'cost_pending' });
    const db = admin();
    await generateVoiceProfile(deps(db), 'r', []);
    expect(finishes(db)).toEqual([expect.objectContaining({ settled: false, result: expect.objectContaining({ tone: '口语' }) })]);
  });
  it('a database failure while saving the profile leaves the run open, never closed as delivered', async () => {
    const db = admin();
    db.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      db.calls.push([name, args]);
      if (name === 'voice_generation_begin') return { data: { replayed: false, version: { id: 'v1' }, material }, error: null };
      return { data: null, error: { message: 'connection reset' } };
    });
    await expect(generateVoiceProfile(deps(db), 'r', [])).rejects.toThrow('VOICE_UNAVAILABLE');
    expect(mocks.billing.closeRun).not.toHaveBeenCalled();
  });
  it('releases the run and records the failure when the balance cannot cover the call', async () => {
    mocks.billing.claimPaygCall!.mockResolvedValue({ id: null, state: 'waiting_credits' });
    const db = admin();
    await generateVoiceProfile(deps(db), 'r', []);
    expect(mocks.billing.dispatchOnce).not.toHaveBeenCalled();
    expect(mocks.billing.requestCancel).toHaveBeenCalledWith('r1');
    expect(finish(db)).toMatchObject({ result: null, failure_code: 'VOICE_INSUFFICIENT_CREDITS' });
  });
  it('settles at the known cost and saves nothing when the answer is not a profile', async () => {
    mocks.text.mockReturnValue('好的');
    const db = admin();
    await generateVoiceProfile(deps(db), 'r', []);
    expect(mocks.billing.closeRun).not.toHaveBeenCalled();
    expect(mocks.billing.requestCancel).toHaveBeenCalled();
    expect(finish(db)).toMatchObject({ result: null, failure_code: 'VOICE_FORMAT_INVALID' });
  });
  it('leaves an unrecorded receipt to the daily recovery', async () => {
    mocks.billing.dispatchOnce!.mockResolvedValue({ dispatched: true, pendingReceipt: { runId: 'r1', callId: 'c1', evidence: {} } });
    mocks.billing.recordReceipt!.mockRejectedValue(new Error('down'));
    const db = admin();
    await generateVoiceProfile(deps(db), 'r', []);
    expect(mocks.billing.requestCancel).not.toHaveBeenCalled();
    expect(finish(db)).toMatchObject({ failure_code: 'VOICE_RESULT_PENDING', settled: false });
  });
  it('marks the version failed when admission refuses, before any hold', async () => {
    mocks.admit.mockRejectedValue(new Error('VOICE_MODEL_NOT_CONFIGURED'));
    const db = admin();
    await expect(generateVoiceProfile(deps(db), 'r', [])).rejects.toThrow('VOICE_MODEL_NOT_CONFIGURED');
    expect(mocks.billing.claimPaygCall).not.toHaveBeenCalled();
    expect(finish(db)).toMatchObject({ failure_code: 'VOICE_MODEL_NOT_CONFIGURED', settled: true });
  });
  it('a repeated request returns the recorded version without another call', async () => {
    const db = admin({ replayed: true, version: { id: 'v1', status: 'generating' } });
    expect((await generateVoiceProfile(deps(db), 'r', [])).status).toBe('generating');
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});
