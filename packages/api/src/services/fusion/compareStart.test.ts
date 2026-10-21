/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const s = vi.hoisted(() => ({
  gate: { positioned: false, refusals24h: 0 } as { positioned: boolean; refusals24h: number },
  begin: {} as Record<string, unknown>, rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>, claim: { state: 'claimed' } as Record<string, unknown>,
  tooLarge: [] as string[], allowed: null as Error | null, endFails: false, existing: null as unknown, probes: 0, admitError: null as Error | null, credits: 10, budget: '1' as string | null, usd: 0n, requests: [] as Array<{ instructions: string }>, admitCalls: [] as unknown[], replayOnly: false,
  archiveAt: null as string | null, cleanupFails: false, replayError: null as Error | null,
}));
vi.mock('./compareAdmission', async original => ({ ...(await original<typeof import('./compareAdmission')>()),
  assertCompareAllowed: async () => { if (s.allowed) throw s.allowed; return { answerOutputTokens: 4096, dispatchMinutes: 10, maxBudgetUsd: s.budget }; },
  buildCompareColumns: async (input: { modelIds: string[]; request: { instructions: string } }) => {
    s.requests.push(input.request);
    return { columns: input.modelIds.map((modelId, index) => ({ index, modelId, upperCredits: s.credits, upperUsd: '0.01' })), tooLarge: s.tooLarge,
      totalCredits: s.credits * input.modelIds.length, totalUsd: s.usd };
  },
  replayCompareGroup: async () => { s.probes += 1; if (s.replayError) throw s.replayError; return s.existing; },
  admitCompareGroup: async (input: { request: { instructions: string }; shown: unknown }) => { s.admitCalls.push(input); if (s.admitError) throw s.admitError;
    return { groupId: id(70), replayed: false, runs: [{ runId: id(80), index: 0, body: 'b', call: { phase: 'fusion_compare' } },
      { runId: id(81), index: 1, body: 'b', call: { phase: 'fusion_compare' } }] }; },
  compareRpc: async (_a: unknown, name: string, args: Record<string, unknown>) => {
    s.rpcs.push({ name, args });
    if (name === s.archiveAt) throw new Error('OPC_BUSINESS_ARCHIVED');
    if (name === 'fusion_compare_stop_archived' && s.cleanupFails) throw new Error('FUSION_ADMISSION_UNAVAILABLE');
    if (name === 'fusion_compare_begin') { if ((s.begin as { __throw?: boolean }).__throw) throw s.begin as unknown as Error; return s.begin; }
    if (name === 'fusion_compare_claim') return s.claim;
    if (name === 'fusion_compare_end' && s.endFails) throw new Error('end failed');
    return {};
  },
}));
vi.mock('../runtime/positioningGate', async original => ({ ...(await original<typeof import('../runtime/positioningGate')>()),
  readPositioningGate: async () => s.gate }));
import { estimateCompare, startCompare, type CompareDeps } from './compareStart';
import { POSITIONING_FALLBACK_INSTRUCTIONS } from '../runtime/positioningFallback';
import { snapshotHash, type CompareParts } from './compareSnapshot';
import { decimal } from '../bill2/decimal';

const admin = {} as SupabaseClient;
const classify = vi.fn();
const refusePositioning = (): never => { throw new Error('POSITIONING_REQUIRED'); };
const rateLimit = vi.fn();
const deps = (): CompareDeps => ({ admin, actorId: id(50), refusePositioning, decisionsKey: async () => 'k', classify, rateLimit });
const parts = (patch: Partial<CompareParts> = {}): CompareParts => ({ skill: null, positioningFallback: false, history: [], workspace: [],
  references: [], question: '哪个更好？', ...patch });
const choice = (patch: Partial<CompareParts> = {}) => ({ sessionId: id(61), historyRevision: 4, modelIds: [id(1), id(2)], parts: parts(patch), materialRevision: '0:none' });
const shown = { credits: 20, columns: [{ modelId: id(1), credits: 10, usd: '0.01' }, { modelId: id(2), credits: 10, usd: '0.01' }] };
const start = (patch: Partial<CompareParts> = {}, extra: Record<string, unknown> = {}) =>
  startCompare(deps(), { ...choice(patch), requestId: id(60), shown, ...extra } as Parameters<typeof startCompare>[1]);
const names = () => s.rpcs.map(call => call.name);
const fresh = (patch: Record<string, unknown> = {}) => ({ compareId: id(90), state: 'admitting', gateVerdict: null, groupId: null, created: true, ...patch });

beforeEach(() => {
  s.gate = { positioned: false, refusals24h: 0 }; s.begin = fresh(); s.rpcs = []; s.claim = { state: 'claimed' }; s.tooLarge = []; s.credits = 10;
  s.requests = []; s.admitCalls = []; classify.mockReset(); classify.mockResolvedValue('allow'); s.budget = '1'; s.usd = 0n; s.endFails = false; s.existing = null; s.probes = 0; s.admitError = null; s.allowed = null;
  rateLimit.mockReset(); rateLimit.mockResolvedValue(undefined);
  s.archiveAt = null; s.cleanupFails = false; s.replayError = null;
});

describe('archived compare cleanup', () => {
  it('cleans by request id when the admission replay probe itself refuses', async () => {
    s.replayError = new Error('OPC_BUSINESS_ARCHIVED');
    await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    expect(names()).toEqual(['fusion_compare_stop_archived']);
  });
  it('cleans the record when group admission refuses after the judgement', async () => {
    s.admitError = new Error('OPC_BUSINESS_ARCHIVED');
    await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    expect(names().at(-1)).toBe('fusion_compare_stop_archived');
    expect(names()).not.toContain('fusion_compare_claim');
  });
  it.each(['fusion_compare_begin', 'fusion_compare_gate', 'fusion_compare_claim'])(
    'ends the persisted request when %s refuses after archive, including runs without any call', async stage => {
      s.archiveAt = stage;
      await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
      expect(s.rpcs.at(-1)).toEqual({ name: 'fusion_compare_stop_archived', args: { p_actor_id: id(50), p_request_id: id(60) } });
    });
  it('retries the same cleanup even when replay refuses before returning a compare id', async () => {
    s.existing = { groupId: id(70), replayed: true, runs: [] }; s.archiveAt = 'fusion_compare_begin';
    await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    expect(names().filter(name => name === 'fusion_compare_stop_archived')).toHaveLength(2);
    expect(names()).not.toContain('fusion_compare_claim');
  });
  it('surfaces cleanup unavailability and retries cleanup on the original request, without another admission', async () => {
    s.archiveAt = 'fusion_compare_claim'; s.cleanupFails = true;
    await expect(start()).rejects.toThrow('FUSION_ADMISSION_UNAVAILABLE');
    s.existing = { groupId: id(70), replayed: true, runs: [] }; s.archiveAt = 'fusion_compare_begin'; s.cleanupFails = false;
    const admitted = s.admitCalls.length;
    await expect(start()).rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    expect(s.admitCalls).toHaveLength(admitted);
    expect(names().filter(name => name === 'fusion_compare_stop_archived')).toHaveLength(2);
  });
  it('keeps non-archive refusals on their existing path', async () => {
    s.admitError = new Error('FUSION_COMPARE_STALE');
    await expect(start()).rejects.toThrow('FUSION_COMPARE_STALE');
    expect(names()).not.toContain('fusion_compare_stop_archived');
  });
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
    expect(names()).not.toContain('fusion_compare_gate'); expect(names()).not.toContain('fusion_compare_claim');
    expect(names().at(-1)).toBe('fusion_compare_end'); // the record is ended, never left holding the user's slot
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

describe('compare start: nothing paid happens for a request that can be refused for free (review findings)', () => {
  it('refuses a selection over the single-compare budget before recording or judging, and says so in the estimate', async () => {
    s.usd = decimal('1.5'); // the administrator's budget is $1
    await expect(start()).rejects.toThrow('FUSION_BUDGET_EXCEEDED');
    expect(classify).not.toHaveBeenCalled();
    expect(names()).not.toContain('fusion_compare_gate'); expect(names()).not.toContain('fusion_compare_claim');
    expect(names().at(-1)).toBe('fusion_compare_end'); // the record is ended, never left holding the user's slot
    expect(await estimateCompare(deps(), choice())).toMatchObject({ overBudget: true });
    s.usd = decimal('0.5');
    expect(await estimateCompare(deps(), choice())).toMatchObject({ overBudget: false });
    s.budget = null; // enabling requires a budget; a missing one never means "unlimited"
    await expect(start()).rejects.toThrow('FUSION_BUDGET_EXCEEDED');
  });
  it('checks the whole quote the user was shown before anything is recorded: count, order, per-column credits and cost', async () => {
    const forged: Array<[string, Record<string, unknown>]> = [
      ['fewer columns than chosen', { shown: { credits: 99, columns: shown.columns.slice(0, 1) } }],
      ['a column cap below its price', { shown: { credits: 99, columns: [{ ...shown.columns[0]!, credits: 9 }, shown.columns[1]!] } }],
      ['a column cost cap below its price', { shown: { credits: 99, columns: [{ ...shown.columns[0]!, usd: '0.001' }, shown.columns[1]!] } }],
      ['columns in another order', { shown: { credits: 99, columns: [shown.columns[1]!, shown.columns[0]!] } }],
      ['a total below the price', { shown: { ...shown, credits: 19 } }],
    ];
    for (const [, patch] of forged) await expect(start({}, patch)).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
    expect(classify).not.toHaveBeenCalled();
    expect(names()).not.toContain('fusion_compare_gate'); expect(names()).not.toContain('fusion_compare_claim');
    expect(names().at(-1)).toBe('fusion_compare_end'); // the record is ended, never left holding the user's slot
  });
  it('applies the message rate limit once per new request, before the paid judgement', async () => {
    await start();
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_gate', 'fusion_compare_claim']);
  });
  it('a request over the rate limit is ended, so it neither judges nor occupies the user\'s one slot', async () => {
    rateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
    await expect(start()).rejects.toThrow('RATE_LIMITED');
    expect(classify).not.toHaveBeenCalled();
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_end']);
    // Even when ending fails, the user still sees the rate limit, not a database error.
    s.rpcs = []; s.endFails = true;
    await expect(start()).rejects.toThrow('RATE_LIMITED');
  });
  it('does not rate-limit a repeat or a resume (they make no new paid call)', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'allow', gateFallback: false, groupId: id(70), state: 'running' });
    await start();
    s.begin = fresh({ created: false, gateVerdict: null });
    await start();
    expect(rateLimit).not.toHaveBeenCalled();
  });
  it('stores the fallback decision with the verdict and replays that decision on a resume, not today\'s refund count', async () => {
    await start(); // below the cap, "allow": the fallback rule applies
    expect(s.rpcs[1]!.args).toMatchObject({ p_verdict: 'allow', p_fallback: true });
    // Resume after the cap was reached in between: the stored decision (with the rule) still wins.
    s.rpcs = []; s.admitCalls = []; s.gate = { positioned: false, refusals24h: 5 };
    s.begin = fresh({ created: false, gateVerdict: 'unavailable', gateFallback: true, groupId: null, snapshotHash: snapshotHash(parts()) });
    await start();
    expect((s.admitCalls[0] as { request: { instructions: string } }).request.instructions).toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
    // And the other way: a 'clear' stored at the cap carries no rule even when old refusals have since expired.
    s.admitCalls = []; s.gate = { positioned: false, refusals24h: 0 };
    s.begin = fresh({ created: false, gateVerdict: 'clear', gateFallback: false, groupId: null, snapshotHash: snapshotHash(parts()) });
    await start();
    expect((s.admitCalls[0] as { request: { instructions: string } }).request.instructions).not.toContain(POSITIONING_FALLBACK_INSTRUCTIONS);
  });
});

describe('compare start: a repeat of an admitted request replays it before anything is repriced (review finding)', () => {
  const frozen = { groupId: id(70), replayed: true, runs: [{ runId: id(80), index: 0, body: 'b', call: { phase: 'fusion_compare' } }] };
  it('returns the frozen group even if prices, the budget or a model changed since: no pricing, no gate, no judgement', async () => {
    s.existing = frozen; s.begin = fresh({ created: false, gateVerdict: 'allow', gateFallback: true, groupId: id(70), state: 'running' });
    s.credits = 99; s.usd = decimal('50'); s.tooLarge = [id(2)]; // everything a fresh start would refuse
    const result = await start();
    expect(result).toMatchObject({ state: 'claimed', compareId: id(90), group: frozen });
    expect(s.requests).toEqual([]);                       // nothing was priced
    expect(classify).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(s.admitCalls).toEqual([]);                    // nothing was admitted again
    expect(names()).toEqual(['fusion_compare_begin', 'fusion_compare_claim']);
  });
  it('still checks that the repeat is the same request, and an ended compare still answers as ended', async () => {
    s.existing = frozen;
    s.begin = fresh({ created: false, gateVerdict: 'allow', groupId: id(70), state: 'stopped' });
    await expect(start()).rejects.toThrow('FUSION_COMPARE_ENDED');
    expect(names()).not.toContain('fusion_compare_claim');
  });
  it('reports waiting for credits again when the first claim could not hold every column', async () => {
    s.existing = frozen; s.claim = { state: 'waiting_credits' };
    s.begin = fresh({ created: false, gateVerdict: 'allow', groupId: id(70), state: 'running' });
    await expect(start()).resolves.toMatchObject({ state: 'waiting_credits' });
  });
  it('answers a repeat of an admitted request even after compare was switched off, so the client can recover its results', async () => {
    s.existing = frozen; s.begin = fresh({ created: false, gateVerdict: 'allow', groupId: id(70), state: 'running' });
    s.allowed = new Error('FUSION_COMPARE_DISABLED');
    await expect(start()).resolves.toMatchObject({ state: 'claimed', compareId: id(90), group: frozen });
  });
  it('still applies the live permissions to a request that has no group yet', async () => {
    s.allowed = new Error('FUSION_COMPARE_DISABLED');
    s.begin = Object.assign(new Error('FUSION_COMPARE_DISABLED'), { __throw: true }) as never;
    await expect(start()).rejects.toThrow('FUSION_COMPARE_DISABLED');
    expect(names()).not.toContain('fusion_compare_claim');
  });
  it('ends a recorded, judged, group-less request that the live rules now refuse, and still reports the refusal', async () => {
    s.allowed = new Error('FUSION_COMPARE_DISABLED');
    s.begin = fresh({ created: false, gateVerdict: 'allow', state: 'admitting' });
    await expect(start()).rejects.toThrow('FUSION_COMPARE_DISABLED');
    expect(names().at(-1)).toBe('fusion_compare_end');
    expect(names()).not.toContain('fusion_compare_gate');
  });
  it('a new request (no group yet) is probed once and then priced as before', async () => {
    await start();
    expect(s.probes).toBe(1);
    expect(s.requests.length).toBe(1);
  });
});


describe('compare start: admission keeps the answer limit recorded with the request (review finding)', () => {
  it('passes the stored limit, not the live setting, to admission after a resume', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'allow', gateFallback: false, state: 'admitting', config: { answerOutputTokens: 2048 } });
    await start();
    expect(s.admitCalls.at(-1)).toMatchObject({ answerTokens: 2048 });
  });
});

describe('compare start: a resumed request is not re-sized with today\'s settings (review finding)', () => {
  it('skips the new-request sizing when the record already exists, even if the live limit would now refuse it', async () => {
    s.begin = fresh({ created: false, gateVerdict: 'allow', gateFallback: false, state: 'admitting', config: { answerOutputTokens: 2048 } });
    s.tooLarge = [id(1)]; s.usd = decimal('50'); s.credits = 99;
    await expect(start()).resolves.toMatchObject({ state: 'claimed' });
    expect(s.requests.length).toBe(0);
    expect(names()).not.toContain('fusion_compare_end');
  });
});


describe('compare start: references and recorded work material (review findings)', () => {
  const withRef = { parts: { ...choice().parts, references: [{ documentId: id(5), version: '1', hash: 'h', title: 't', text: 'x' }] } };
  it('refuses @ library documents in this version, before pricing or recording anything', async () => {
    await expect(start({}, withRef)).rejects.toThrow('FUSION_COMPARE_REFERENCES_UNSUPPORTED');
    await expect(estimateCompare(deps(), { ...choice(), ...withRef })).rejects.toThrow('FUSION_COMPARE_REFERENCES_UNSUPPORTED');
    expect(names()).toEqual([]);
  });
  it('records the work-material revision with the request', async () => {
    await start({}, { materialRevision: '7:abc' });
    const begin = s.rpcs.find(call => call.name === 'fusion_compare_begin')!;
    expect((begin.args.p_request as { config: { materialRevision: unknown } }).config.materialRevision).toBe('7:abc');
  });
});

describe('compare start: material withdrawn while the judgement ran (review finding)', () => {
  it.each(['FUSION_COMPARE_STALE', 'RUNTIME_MATERIAL_UNAVAILABLE', 'FUSION_COMPARE_SOURCE_REVOKED', 'FUSION_COMPARE_SESSION_GONE',
    'FUSION_COMPARE_PRICE_CHANGED', 'FUSION_BUDGET_EXCEEDED', 'FUSION_COMPARE_MODEL_NOT_ALLOWED', 'FUSION_COMPARE_INPUT_TOO_LARGE'])('ends the record when admission refuses with %s, and holds nothing', async code => {
    s.admitError = new Error(code);
    await expect(start()).rejects.toThrow(code);
    expect(names()).not.toContain('fusion_compare_claim');
    expect(names().at(-1)).toBe('fusion_compare_end');
  });
  it.each(['FUSION_ADMISSION_UNAVAILABLE', 'FUSION_GROUP_CONFLICT', 'FUSION_COMPARE_REQUEST_CONFLICT'])(
    'keeps the record for %s (a retry of the same request may still succeed or must find the same group)', async code => {
      s.admitError = new Error(code);
      await expect(start()).rejects.toThrow(code);
      expect(names()).not.toContain('fusion_compare_end');
    });
});

describe('compare start: the request identity binds the frozen context (review finding)', () => {
  const hashOf = async (patch: Record<string, unknown> = {}, parts: Partial<CompareParts> = {}) => {
    s.rpcs.length = 0; s.begin = fresh();
    await start(parts, patch);
    const call = s.rpcs.find(item => item.name === 'fusion_compare_begin')!;
    return (call.args.p_request as { requestHash: string }).requestHash;
  };
  it('changes when the conversation revision, the work material or the workspace sources change, and not otherwise', async () => {
    const base = await hashOf();
    expect(await hashOf()).toBe(base);
    expect(await hashOf({ historyRevision: 5 })).not.toBe(base);
    expect(await hashOf({ materialRevision: '9:other' })).not.toBe(base);
    expect(await hashOf({}, { workspace: [{ sourceVersionId: id(77), kind: 'positioning', body: 'b' }] })).not.toBe(base);
    expect(await hashOf({}, { history: [{ role: 'user', text: 'earlier' }] })).not.toBe(base);
  });
});
