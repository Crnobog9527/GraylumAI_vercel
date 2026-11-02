/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock('../turn/voice', () => ({ runVoiceTurn: mocks.turn }));
vi.mock('../platformSecrets/request', () => ({ withPlatformSecretRequest: <T,>(work: () => T) => work() }));
vi.mock('../turn/settings/catalogCache', () => ({ withCatalogRequest: <T,>(work: () => T) => work() }));
import { generateVoiceProfile } from './generation';

const material = [{ documentId: 'd1', filename: 'a.md', text: '哎下班到家都七点了，咋整。\n一口锅搞定呗。' }];
function admin(begin: unknown = { replayed: false, version: { id: 'v1' }, material }) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    calls.push([name, args]);
    if (name === 'voice_generation_begin') return { data: begin, error: null };
    if (name === 'voice_generation_finish') return { data: { id: 'v1', status: args.failure_code ? 'failed' : 'draft' }, error: null };
    return { data: null, error: null };
  }) };
}
const deps = (db: ReturnType<typeof admin>) => ({ admin: db as never, actorId: 'a1', chat: {} as never });
const finishes = (db: ReturnType<typeof admin>) => db.calls.filter(([name]) => name === 'voice_generation_finish').map(([, args]) => args);

beforeEach(() => { vi.clearAllMocks(); mocks.turn.mockResolvedValue({ saved: true, turnId: 7 }); });

describe('generateVoiceProfile', () => {
  it('runs the voice turn on the frozen corpus and returns the version the close saved', async () => {
    const db = admin();
    expect((await generateVoiceProfile(deps(db), 'r', [])).status).toBe('draft');
    expect(mocks.turn).toHaveBeenCalledWith({}, { actorId: 'a1', requestId: 'r', versionId: 'v1', material });
    // The profile was saved by the turn's own close; this only reads the version (no result, no failure).
    expect(finishes(db)).toEqual([expect.objectContaining({ result: null, failure_code: null, settled: true })]);
  });
  it('records the failure word the turn ended with and returns the failed version', async () => {
    for (const code of ['VOICE_INSUFFICIENT_CREDITS', 'VOICE_FORMAT_INVALID', 'VOICE_RESULT_PENDING', 'VOICE_PAUSED']) {
      mocks.turn.mockResolvedValueOnce({ saved: false, code, turnId: 7 });
      const db = admin();
      expect((await generateVoiceProfile(deps(db), 'r', [])).status).toBe('failed');
      expect(finishes(db)).toEqual([expect.objectContaining({ result: null, failure_code: code, settled: true })]);
    }
  });
  it('a model that is not configured is refused after the version is marked failed', async () => {
    mocks.turn.mockResolvedValue({ saved: false, code: 'VOICE_MODEL_NOT_CONFIGURED' });
    const db = admin();
    await expect(generateVoiceProfile(deps(db), 'r', [])).rejects.toThrow('VOICE_MODEL_NOT_CONFIGURED');
    expect(finishes(db)).toEqual([expect.objectContaining({ failure_code: 'VOICE_MODEL_NOT_CONFIGURED' })]);
  });
  it('a version deleted meanwhile is reported as gone', async () => {
    const db = admin();
    db.rpc.mockImplementation(async (name: string) => name === 'voice_generation_begin'
      ? { data: { replayed: false, version: { id: 'v1' }, material }, error: null }
      : { data: { status: 'deleted' }, error: null });
    await expect(generateVoiceProfile(deps(db), 'r', [])).rejects.toThrow('VOICE_VERSION_GONE');
  });
  it('a database failure before the turn leaves nothing started', async () => {
    const db = admin();
    db.rpc.mockImplementation(async () => ({ data: null, error: { message: 'connection reset' } }));
    await expect(generateVoiceProfile(deps(db), 'r', [])).rejects.toThrow('VOICE_UNAVAILABLE');
    expect(mocks.turn).not.toHaveBeenCalled();
  });
  it('a repeated request returns the recorded version without another call', async () => {
    const db = admin({ replayed: true, version: { id: 'v1', status: 'generating' } });
    expect((await generateVoiceProfile(deps(db), 'r', [])).status).toBe('generating');
    expect(mocks.turn).not.toHaveBeenCalled();
  });
});
