/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { admitContentSource, ContentSourceRefusal, injectContentSource, withInjectedSource } from './contentSource';
import { runtimeContext } from './runtimeContext';
import { fittingCandidates, matchCandidate, type MatchCandidate } from './matching';
import { StagingAccessError } from './stagingErrors';

const args = { p_execution_id: randomUUID() };
const context = { input: '出一版分镜', purposeBudget: { inputBytes: 32000 } } as never;
const contentId = randomUUID();
function rpc(result: unknown) {
  const calls: unknown[] = [];
  return { calls, rpc: async <T>(name: string, value: Record<string, unknown>) => { calls.push({ name, value }); return result as T; } };
}

describe('A2 executor content source', () => {
  it('reads and records through one checkpoint and puts the body only into this call\'s instructions', async () => {
    const db = rpc({ status: 'injected', contentId, kind: 'script', version: 2, body: 'SCRIPT_BODY_CANARY' });
    const instructions = await injectContentSource(db.rpc, args, 'script', 'SKILL', context, 100000, 0);
    expect(db.calls).toEqual([{ name: 'runtime_execution', value: { ...args, p_action: 'checkpoint_source', p_result: { kind: 'script' } } }]);
    expect(instructions).toBe(withInjectedSource('SKILL', 'script', 2, 'SCRIPT_BODY_CANARY'));
    expect(instructions.startsWith('SKILL\n')).toBe(true);
  });
  it('leaves a session without saved content (free chat) unchanged', async () => {
    expect(await injectContentSource(rpc({ status: 'none' }).rpc, args, 'storyboard', 'SKILL', context, 100000, 0)).toBe('SKILL');
  });
  it.each(['RUNTIME_CONTENT_SOURCE_MISSING', 'RUNTIME_CONTENT_SOURCE_STALE'])('ends the turn with %s', async code => {
    const refused = injectContentSource(rpc({ status: 'refused', code }).rpc, args, 'storyboard', 'SKILL', context, 100000, 0);
    await expect(refused).rejects.toEqual(new ContentSourceRefusal(code as never));
  });
  it('refuses a source too large for this call instead of dispatching it', async () => {
    const db = rpc({ status: 'injected', contentId, kind: 'script', version: 1, body: '长'.repeat(20000) });
    await expect(injectContentSource(db.rpc, args, 'script', 'SKILL', context, 30000, 0))
      .rejects.toEqual(new ContentSourceRefusal('RUNTIME_CONTENT_SOURCE_TOO_LARGE'));
  });
  it('rejects any checkpoint result outside the contract', async () => {
    for (const result of [{ status: 'injected', contentId, kind: 'editing', version: 1, body: 'x' },
      { status: 'refused', code: 'OTHER' }, { status: 'none', body: 'x' }])
      await expect(injectContentSource(rpc(result).rpc, args, 'script', 'SKILL', context, 100000, 0)).rejects.toThrow();
  });
});

describe('A2 admission of a chosen derived-content Skill', () => {
  const admin = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) });
  const base = { actorId: randomUUID(), sessionId: randomUUID(), kind: 'script' as const };
  it('freezes the chosen version after sizing it, without reading the body', async () => {
    const sized: number[] = [];
    const frozen = await admitContentSource(admin({ status: 'ready', contentId, kind: 'script', bytes: 1200 }),
      { ...base, fits: bytes => { sized.push(bytes); } });
    expect(frozen).toEqual({ contentId, kind: 'script' });
    expect(sized[0]).toBeGreaterThan(1200);
    expect(runtimeContext.shape.sourceContent.parse(frozen)).toEqual(frozen);
  });
  it('admits a session without saved content without a source', async () => {
    expect(await admitContentSource(admin({ status: 'none' }), { ...base, fits: () => {} })).toBeUndefined();
  });
  it('refuses before any charge with the user-facing code', async () => {
    await expect(admitContentSource(admin({ status: 'refused', code: 'RUNTIME_CONTENT_SOURCE_STALE' }), { ...base, fits: () => {} }))
      .rejects.toEqual(new StagingAccessError('RUNTIME_CONTENT_SOURCE_STALE'));
    const tooLarge = admitContentSource(admin({ status: 'ready', contentId, kind: 'script', bytes: 9 }),
      { ...base, fits: () => { throw new Error('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY'); } });
    await expect(tooLarge).rejects.toEqual(new StagingAccessError('RUNTIME_CONTENT_SOURCE_TOO_LARGE'));
    await expect(admitContentSource(admin(null, { code: '57014' }), { ...base, fits: () => {} })).rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
  });
});

describe('A2 matching plan', () => {
  const candidate = (key: number): MatchCandidate => matchCandidate.parse({ key: 'candidate-' + key, name: 'Skill ' + key, description: '',
    moduleId: randomUUID(), skillId: randomUUID(), packageId: 'p', revisionId: randomUUID(), packageHash: 'a'.repeat(64),
    modelId: randomUUID(), model: 'm', inputLimit: 100000, outputLimit: 100, requiresTask: false });
  it('freezes each kept candidate\'s declared content source; older plans without it still parse', async () => {
    const [plain, storyboard] = [candidate(0), candidate(1)];
    const kept = await fittingCandidates([plain, storyboard],
      async c => c === storyboard ? { instructions: 'SKILL', contentSource: 'script' } : 'SKILL',
      { input: 'hi', inputBytes: 100000, toolBytes: 0, instructions: skill => skill });
    expect(kept.map(c => c.contentSource)).toEqual([undefined, 'script']);
    expect(matchCandidate.parse(kept[1]).contentSource).toBe('script');
    expect(() => matchCandidate.parse({ ...plain, contentSource: 'editing' })).toThrow();
  });
});
