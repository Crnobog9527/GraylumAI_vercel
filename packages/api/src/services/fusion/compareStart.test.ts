/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const s = vi.hoisted(() => ({
  gate: { positioned: false, refusals24h: 0 } as { positioned: boolean; refusals24h: number },
  begin: {} as Record<string, unknown>, rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>, claim: { state: 'claimed' } as Record<string, unknown>,
  tooLarge: [] as string[], credits: 10, requests: [] as Array<{ instructions: string }>, admitCalls: [] as unknown[], replayOnly: false,
}));
vi.mock('./compareAdmission', () => ({
  assertCompareAllowed: async () => ({ answerOutputTokens: 4096, dispatchMinutes: 10 }),
  buildCompareColumns: async (input: { modelIds: string[]; request: { instructions: string } }) => {
    s.requests.push(input.request);
    return { columns: input.modelIds.map((modelId, index) => ({ index, modelId, upperCredits: s.credits, upperUsd: '0.01' })), tooLarge: s.tooLarge,
      totalCredits: s.credits * input.modelIds.length, totalUsd: 0n };
  },
  admitCompareGroup: async (input: { request: { instructions: string }; shown: unknown }) => { s.admitCalls.push(input);
    return { groupId: id(70), replayed: false, runs: [{ runId: id(80), index: 0, body: 'b', call: { phase: 'fusion_compare' } },
      { runId: id(81), index: 1, body: 'b', call: { phase: 'fusion_compare' } }] }; },
  compareRpc: async (_a: unknown, name: string, args: Record<string, unknown>) => {
    s.rpcs.push({ name, args });
    if (name === 'fusion_compare_begin') return s.begin;
    if (name === 'fusion_compare_claim') return s.claim;
    return {};
  },
}));
vi.mock('../runtime/positioningGate', async original => ({ ...(await original<typeof import('../runtime/positioningGate')>()),
  readPositioningGate: async () => s.gate }));
import { estimateCompare, startCompare, type CompareDeps } from './compareStart';
import { POSITIONING_FALLBACK_INSTRUCTIONS } from '../runtime/positioningFallback';
import { snapshotHash, type CompareParts } from './compareSnapshot';

const admin = {} as SupabaseClient;
const classify = vi.fn();
const refusePositioning = (): never => { throw new Error('POSITIONING_REQUIRED'); };
const deps = (): CompareDeps => ({ admin, actorId: id(50), refusePositioning, decisionsKey: async () => 'k', classify });
const parts = (patch: Partial<CompareParts> = {}): CompareParts => ({ skill: null, positioningFallback: false, history: [], workspace: [],
  references: [], question: '哪个更好？', ...patch });
const choice = (patch: Partial<CompareParts> = {}) => ({ sessionId: id(61), historyRevision: 4, modelIds: [id(1), id(2)], parts: parts(patch) });
const shown = { credits: 20, tooLarge: [], refundCapReached: false, columns: [{ modelId: id(1), credits: 10, usd: '0.01' }, { modelId: id(2), credits: 10, usd: '0.01' }] };
const start = (patch: Partial<CompareParts> = {}, extra: Record<string, unknown> = {}) =>
  startCompare(deps(), { ...choice(patch), requestId: id(60), shown, ...extra } as Parameters<typeof startCompare>[1]);
const names = () => s.rpcs.map(call => call.name);
const fresh = (patch: Record<string, unknown> = {}) => ({ compareId: id(90), state: 'admitting', gateVerdict: null, groupId: null, created: true, ...patch });

beforeEach(() => {
  s.gate = { positioned: false, refusals24h: 0 }; s.begin = fresh(); s.rpcs = []; s.claim = { state: 'claimed' }; s.tooLarge = []; s.credits = 10;
  s.requests = []; s.admitCalls = []; classify.mockReset(); classify.mockResolvedValue('allow');
});

describe('compare estimate', () => {
  it('prices the worst-case request (with the fallback rule) and makes no paid judgement', async () => {
    const estimate = await estimateCompare(deps(), choice());
    expect(estimate).toMatchObject({ credits: 20, tooLarge: [], refundCapReached: false });
    expect(estimate.columns).toEqual([{ modelId: id(1), credits: 10, usd: '0.01' }, { modelId: id(2), credits: 10, usd: '0.01' }]);
    expect(s.requests[0]!.instructions).toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
    expect(classify).not.toHaveBeenCalled();
    expect(s.rpcs).toEqual([]);
  });
  it('can be called repeatedly without any cost: never judges, never records', async () => {
    for (let i = 0; i < 3; i++) await estimateCompare(deps(), choice());
    expect(classify).not.toHaveBeenCalled();
    expect(s.rpcs).toEqual([]);
  });
  it('refuses a social-media Skill for a user without a positioning, but only reports the refund cap otherwise', async () => {
    const skill = { moduleId: 'm', revisionId: 'r', instructions: 'S', resources: [], socialMedia: true };
    await expect(estimateCompare(deps(), choice({ skill }))).rejects.toThrow('POSITIONING_REQUIRED');
    s.gate = { positioned: true, refusals24h: 0 };
    await expect(estimateCompare(deps(), choice({ skill }))).resolves.toBeDefined();
    s.gate = { positioned: false, refusals24h: 5 };
    await expect(estimateCompare(deps(), choice())).resolves.toMatchObject({ refundCapReached: true });
  });
  it('lists the models that cannot take the request instead of throwing', async () => {
    s.tooLarge = [id(2)];
    await expect(estimateCompare(deps(), choice())).resolves.toMatchObject({ tooLarge: [id(2)] });
  });
});

describe('compare start', () => {
  it('records the request first, judges once, writes the verdict, then admits and claims; the fallback rule rides along', async () => {
    const result = await start();
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_gate', 'fusion_compare_claim']);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(s.rpcs[1]!.args).toMatchObject({ p_compare_id: id(90), p_verdict: 'allow' });
    expect(result).toMatchObject({ state: 'claimed', compareId: id(90) });
    expect((s.admitCalls[0] as { request: { instructions: string } }).request.instructions).toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
    expect(s.rpcs[2]!.args.p_items).toEqual([{ runId: id(80), sequence: 1, payload: { phase: 'fusion_compare' } },
      { runId: id(81), sequence: 1, payload: { phase: 'fusion_compare' } }]);
  });
  it('records the request before the paid judgement and freezes its full identity, snapshot and workspace dependencies', async () => {
    await start({ workspace: [{ sourceVersionId: id(7), kind: 'positioning', body: 'P' }] });
    const request = s.rpcs[0]!.args.p_request as Record<string, unknown>;
    expect(request).toMatchObject({ question: '哪个更好？', historyRevision: '4', workspaceDependencies: [{ sourceVersionId: id(7) }],
      config: { models: [id(1), id(2)], skill: null } });
    expect(request.snapshotHash).toBe(snapshotHash(parts({ workspace: [{ sourceVersionId: id(7), kind: 'positioning', body: 'P' }] })));
    expect(request.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(names()[0]).toBe('fusion_compare_begin');
  });
  it('a user with a positioning is admitted with no paid judgement and without the fallback rule', async () => {
    s.gate = { positioned: true, refusals24h: 0 };
    await start();
    expect(classify).not.toHaveBeenCalled();
    expect(s.rpcs[1]!.args.p_verdict).toBe('allow');
    expect((s.admitCalls[0] as { request: { instructions: string } }).request.instructions).not.toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
  });
  it('a blocked message records the verdict, creates no group and refuses with the positioning guide', async () => {
    classify.mockResolvedValue('block');
    await expect(start()).rejects.toThrow('POSITIONING_REQUIRED');
    expect(s.rpcs[1]!.args.p_verdict).toBe('block');
    expect(names()).not.toContain('fusion_compare_claim');
    expect(s.admitCalls).toHaveLength(0);
  });
  it('at the refund cap an unusable judgement is refused with no group, and a clear one goes on without the fallback rule', async () => {
    s.gate = { positioned: false, refusals24h: 5 };
    classify.mockResolvedValue('unavailable');
    await expect(start()).rejects.toThrow('POSITIONING_REQUIRED');
    expect(s.admitCalls).toHaveLength(0);
    s.rpcs = []; classify.mockResolvedValue('clear');
    await start();
    expect((s.admitCalls[0] as { request: { instructions: string } }).request.instructions).not.toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
  });
  it('never makes a paid call for a request that is refused before it is recorded (price, size)', async () => {
    s.tooLarge = [id(1)];
    await expect(start()).rejects.toThrow('FUSION_COMPARE_INPUT_TOO_LARGE');
    s.tooLarge = []; s.credits = 11;
    await expect(start()).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
    expect(classify).not.toHaveBeenCalled();
    expect(s.rpcs).toEqual([]);
  });
  it('a repeat of a judged request never judges again and returns the same group', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'allow', groupId: id(70), state: 'running' });
    const result = await start();
    expect(classify).not.toHaveBeenCalled();
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_claim']);
    expect(result).toMatchObject({ state: 'claimed', compareId: id(90) });
  });
  it('a repeat while the first request is still judging is told to wait, not judged', async () => {
    s.begin = fresh({ created: false, gateVerdict: null });
    await expect(start()).resolves.toEqual({ state: 'processing', compareId: id(90) });
    expect(classify).not.toHaveBeenCalled();
    expect(names()).toEqual(['fusion_compare_begin']);
  });
  it('a start interrupted after the judgement carries on when the snapshot is exactly the recorded one', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'unavailable', groupId: null, snapshotHash: snapshotHash(parts()) });
    await start();
    expect(classify).not.toHaveBeenCalled();
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_claim']);
    expect(s.admitCalls).toHaveLength(1);
  });
  it('...and ends the compare, charging nothing, when the conversation or a source changed in between', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'unavailable', groupId: null, snapshotHash: 'f'.repeat(64) });
    await expect(start()).rejects.toThrow('FUSION_COMPARE_STALE');
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_end']);
    expect(s.admitCalls).toHaveLength(0);
  });
  it('once the group exists a different snapshot is irrelevant: it is a replay of frozen runs, never ended', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'allow', groupId: id(70), state: 'running', snapshotHash: 'f'.repeat(64) });
    await start();
    expect(names()).not.toContain('fusion_compare_end');
  });
  it('an ended record answers as ended; a refused one with a block verdict answers with the positioning guide', async () => {
    s.begin = fresh({ created: false, state: 'stopped', gateVerdict: 'allow' });
    await expect(start()).rejects.toThrow('FUSION_COMPARE_ENDED');
    s.begin = fresh({ created: false, state: 'refused', gateVerdict: 'block' });
    await expect(start()).rejects.toThrow('POSITIONING_REQUIRED');
  });
  it('reports waiting for credits when the group claim cannot hold every column', async () => {
    s.claim = { state: 'waiting_credits' };
    await expect(start()).resolves.toMatchObject({ state: 'waiting_credits' });
  });
});
