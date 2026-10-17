/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { researchExecution, responseAfterResearch } from './researchExecution';
import { frozenResearchTurn, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TURN_VERSION } from './researchTurn';
import { terminalReplyGuard } from './executorRpc';
import { toolCallPolicy } from '../bill2/toolBilling';
import { streamOriginalExecution } from './executionStream';
import type { RuntimeProgress } from './progress';
import type { ResearchTurnEvent } from '../../shared/researchTurn';
import { resetPlatformSecretCacheForTests } from '../platformSecrets/reader';

vi.mock('../redisRateLimiter', () => ({ checkVendorRateLimit: vi.fn(async () => true) }));

const actor = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const executionId = '44444444-4444-4444-8444-444444444444';
const callId = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
const research = frozenResearchTurn.parse({ version: RESEARCH_TURN_VERSION, configRevision: 1, phase: RESEARCH_PHASE, subcalls: 4,
  reserve: RESEARCH_RESULT_RESERVE_BYTES, vendors: ['parallel'], verifiedPlatforms: [], benchmarkPlatforms: [],
  routes: [{ platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' }],
  discoverSubcalls: 4, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' } });
const now = new Date('2026-10-17T00:00:00Z');
const policy = toolCallPolicy({ vendor: 'parallel', account: 'research-local', route: 'parallel:search:fast', purposes: [RESEARCH_PHASE],
  maxUnitsPerCall: '1', price: { entryHash: 'e'.repeat(64), matchedBy: 'route', multiplier: '6', multiplierSource: 'global',
    entry: { provider: 'parallel', route: 'parallel:search:fast', appliesToUnlistedRoutes: false, currency: 'USD', usageUnit: 'sku_search',
      unitsPerPrice: '1', price: '0.005', usdPerCurrency: null, fxSourceUrl: null, fxEffectiveAt: null, fxValidUntil: null,
      pricingBasis: 'list', sourceUrl: 'https://example.com/p', evidenceHash: 'a'.repeat(64), verifiedAt: '2026-10-01T00:00:00Z',
      validUntil: '2026-11-01T00:00:00Z', chargeCondition: 'per call', includedInReceipt: false, priceMultiplier: null } } });

function database(calls: Array<{ id: string; sequence: number; providerId: string | null }>, claim: unknown = { state: 'waiting_credits' },
  toolCalls: string[] = []) {
  const rpc = vi.fn(async (name: string, ...rest: [Record<string, unknown>]) => {
    if (name === 'bill2_read') return { data: { id: runId, calls }, error: null };
    // The admin slot is not filled: the transition fallback (PARALLEL_API_KEY) applies.
    if (name === 'platform_secret_read') return { data: null, error: null };
    if (name === 'research_runtime_read') return { data: null, error: null };
    if (name === 'bill2_claim') return { data: claim, error: null };
    if (name === 'research_runtime_call_charge') return { data: toolCalls.includes(String(rest[0].p_call)) ? { source: null, credits: null } : null, error: null };
    throw new Error(`unexpected ${name}`);
  });
  return { rpc };
}
const execution = (live: boolean) => ({ sessionId, runId, epoch: 4, live,
  billing: { callPolicy: [{ modelId: actor, model: 'vendor/model', protocol: 'openrouter-chat-v1' }, policy] } } as never);
function build(live: boolean, db: ReturnType<typeof database>, canSend = () => true) {
  const events: ResearchTurnEvent[] = [];
  const onPause = vi.fn();
  const built = researchExecution({ research, tools: ['ask_question', 'web_search'], execution: execution(live), executionId,
    actorId: actor, database: db, emit: event => events.push(event), onClosed: () => {}, onPause, canSend, now: () => now })!;
  return { built, events, onPause };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetPlatformSecretCacheForTests(); });

describe('researchExecution (RT-3b PR-3)', () => {
  it('offers nothing without frozen research, and only the frozen tools with it', () => {
    expect(researchExecution({ research: undefined, tools: ['ask_question'], execution: execution(true), executionId, actorId: actor,
      database: database([]), emit: () => {}, onClosed: () => {}, onPause: () => {}, canSend: () => true })).toBeNull();
    const { built } = build(true, database([]));
    expect(built.tools.map(tool => tool.name)).toEqual(['web_search']);
    expect(built.reserve).toBe(RESEARCH_RESULT_RESERVE_BYTES);
    expect(built.definitionBytes).toBeGreaterThan(0);
  });

  it('claims the run\'s next free sequence with the owner epoch as an integer and the research phase', async () => {
    vi.stubEnv('PARALLEL_API_KEY', 'test-key');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const db = database([{ id: callId(1), sequence: 1, providerId: 'gen-1' }, { id: callId(2), sequence: 2, providerId: callId(2) }]);
    const { built, events, onPause } = build(true, db);
    // Waiting for credits: nothing held or sent; the turn pauses at this slot instead of telling the model to go on without it.
    await expect(built.tools[0]!.execute({ query: 'coffee shops', mode: 'fast' }, 'call-1')).rejects.toThrow('RUNTIME_WAITING_CREDITS');
    const claim = db.rpc.mock.calls.find(([name]) => name === 'bill2_claim')!;
    expect(claim[1]).toMatchObject({ p_run_id: runId, p_actor_id: actor, p_sequence: 3,
      p_payload: { runtimeEpoch: 4, phase: RESEARCH_PHASE, protocol: 'research-tool-v1', model: policy.model } });
    expect(typeof (claim[1].p_payload as { runtimeEpoch: unknown }).runtimeEpoch).toBe('number');
    expect(fetch).not.toHaveBeenCalled();
    // The host saves this exact slot as the pause point (payg_wait); the resumed turn claims it with the same request.
    expect(onPause).toHaveBeenCalledExactlyOnceWith({ sequence: 3,
      requestHash: (claim[1].p_payload as { requestHash: string }).requestHash, phase: RESEARCH_PHASE }, 'waiting_credits');
    expect((claim[1].p_payload as { requestHash: string }).requestHash).toMatch(/^[a-f0-9]{64}$/);
    // Started, never reported as failed: it runs again after the top-up.
    expect(events.map(event => event.type === 'research_call' && event.state)).toEqual(['running']);
  });

  it('a replay never claims or sends a subcall', async () => {
    vi.stubEnv('PARALLEL_API_KEY', 'test-key');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const db = database([]);
    const { built } = build(false, db);
    await expect(built.tools[0]!.execute({ query: 'coffee shops', mode: 'fast' }, 'call-1')).rejects.toThrow('RUNTIME_RESPONSE_PENDING');
    expect(db.rpc.mock.calls.some(([name]) => name === 'bill2_claim')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recognises a slot as a subcall by the database\'s call kind, also without a receipt (#1029 P1)', async () => {
    const db = database([{ id: callId(1), sequence: 1, providerId: 'gen-1' }, { id: callId(2), sequence: 2, providerId: callId(2) },
      { id: callId(3), sequence: 3, providerId: null }, { id: callId(4), sequence: 4, providerId: null }],
    undefined, [callId(2), callId(3)]);
    const { built } = build(true, db);
    expect(await built.isSubcall(1)).toBe(false);
    expect(await built.isSubcall(2)).toBe(true);
    // Claimed, then cancelled by recovery before any receipt: still this answer's tool call.
    expect(await built.isSubcall(3)).toBe(true);
    // An unrecorded model call is never skipped.
    expect(await built.isSubcall(4)).toBe(false);
    expect(await built.isSubcall(5)).toBe(false);
    expect(db.rpc).toHaveBeenCalledWith('research_runtime_call_charge', { a: actor, s: sessionId, e: executionId, p_call: callId(3) });
  });
});

describe('responseAfterResearch', () => {
  const conflict = () => { throw new Error('RUNTIME_RESPONSE_CONFLICT'); };
  it('moves past recorded subcalls to the model call\'s own slot', async () => {
    const respond = vi.fn(async (sequence: number) => sequence === 4 ? { rawBody: 'saved' } : conflict());
    const subcalls = new Set([2, 3]);
    expect(await responseAfterResearch(respond, 2, { isSubcall: async n => subcalls.has(n) }, 8))
      .toEqual({ sequence: 4, existing: { rawBody: 'saved' } });
  });
  it('a free slot is returned for a new claim; any other conflict still fails', async () => {
    expect(await responseAfterResearch(async () => null, 5, { isSubcall: async () => true }, 8)).toEqual({ sequence: 5, existing: null });
    await expect(responseAfterResearch(async () => conflict(), 2, { isSubcall: async () => false }, 8)).rejects.toThrow('RUNTIME_RESPONSE_CONFLICT');
    await expect(responseAfterResearch(async () => conflict(), 2, null, 8)).rejects.toThrow('RUNTIME_RESPONSE_CONFLICT');
    // Never past the run's own ceiling.
    await expect(responseAfterResearch(async () => conflict(), 8, { isSubcall: async () => true }, 8)).rejects.toThrow('RUNTIME_RESPONSE_CONFLICT');
  });
});

describe('one research call per mentor turn', () => {
  const call = (name: string) => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: '{}' } }] } }] });
  it('accepts the first offered research call and refuses a second or an unoffered one', () => {
    const failed = vi.fn();
    const guard = terminalReplyGuard(true, true, failed, false, false, ['web_search', 'web_fetch']);
    expect(() => guard(call('web_search'))).not.toThrow();
    expect(() => guard(call('web_fetch'))).toThrow('RUNTIME_TERMINAL_REPLY');
    expect(failed).toHaveBeenCalledOnce();
    const plain = terminalReplyGuard(true, true, vi.fn());
    expect(() => plain(call('web_search'))).toThrow('RUNTIME_TERMINAL_REPLY');
  });
});

describe('research events on the turn stream', () => {
  it('keeps every research call and card, in order, beside the latest text', async () => {
    let emit: (event: RuntimeProgress) => void = () => {};
    let finish: () => void = () => {};
    const stream = streamOriginalExecution(onProgress => { emit = onProgress; return new Promise(resolve => {
      finish = () => resolve({ state: 'completed', body: '' }); }); }, undefined, 'opc.mentorTurnStream');
    const first = stream.next();
    const running = { type: 'research_call', callId: callId(1), toolName: 'web_search', args: {}, query: 'q', platform: 'web',
      dataKind: 'web_search', state: 'running' } as const;
    emit(running);
    emit({ ...running, state: 'succeeded', evidenceId: callId(1), credits: '0.5' });
    emit({ type: 'research_card', card: { cardId: callId(2), kind: 'keywords', minSelect: 1, maxSelect: 5, options: [{ id: 'k0', text: 'a' }] } });
    emit({ type: 'text', text: 'x' });
    emit({ type: 'text', text: 'xy' });
    emit({ ...running, callId: callId(3) });
    finish();
    const seen = [(await first).value];
    for await (const event of { [Symbol.asyncIterator]: () => stream }) seen.push(event);
    expect(seen.map(event => event.type === 'research_call' ? `call:${event.state}` : event.type)).toEqual(
      ['call:running', 'call:succeeded', 'research_card', 'text', 'call:running', 'result']);
  });
});

describe('#1029 review fixes', () => {
  it('a backpressured stream still delivers finished research events before the answer written after them', async () => {
    let emit: (event: RuntimeProgress) => void = () => {};
    let finish: () => void = () => {};
    const stream = streamOriginalExecution(onProgress => { emit = onProgress; return new Promise(resolve => {
      finish = () => resolve({ state: 'completed', body: '' }); }); }, undefined, 'opc.mentorTurnStream');
    const first = stream.next();
    const call = { type: 'research_call', callId: callId(1), toolName: 'web_search', args: {}, query: 'q', platform: 'web',
      dataKind: 'web_search' } as const;
    emit({ ...call, state: 'running' });
    // The consumer has not pulled again while the subcall finishes and the model writes its answer.
    emit({ ...call, state: 'succeeded' });
    emit({ type: 'text', text: 'answer' });
    finish();
    const seen = [(await first).value];
    for await (const event of { [Symbol.asyncIterator]: () => stream }) seen.push(event);
    expect(seen.map(event => event.type === 'research_call' ? `call:${event.state}` : event.type))
      .toEqual(['call:running', 'call:succeeded', 'text', 'result']);
  });

  it('web_search offers only the fast mode when no advanced route was frozen', async () => {
    const { built } = build(true, database([]));
    const schema = JSON.stringify(z.toJSONSchema(built.tools[0]!.parameters!));
    expect(schema).toContain('"fast"');
    expect(schema).not.toContain('"pro"');
    const withPro = researchExecution({ research: { ...research, routes: [...research.routes,
      { platform: 'web', kind: 'web_search_pro', vendor: 'parallel', route: 'parallel:search:advanced', backup: null, maxUnitsPerCall: '1' }] },
    tools: ['web_search'], execution: execution(true), executionId, actorId: actor, database: database([]), emit: () => {}, onClosed: () => {},
    onPause: () => {}, canSend: () => true })!;
    expect(JSON.stringify(z.toJSONSchema(withPro.tools[0]!.parameters!))).toContain('"pro"');
    expect(withPro.definitionBytes).toBeGreaterThan(built.definitionBytes);
  });
});
