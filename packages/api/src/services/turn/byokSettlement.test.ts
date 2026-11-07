/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound } from './provider/openRouterPolicy';
import type { TransportObservation } from './provider/fixtureAdapter';
import { modelCall, type ModelCall } from './call';
import type { CounterStore } from './limiter';
import type { RecoveryItem, TurnDatabase } from './db';
import { recoverTurns, type TurnRecoveryDeps } from './recovery';
import { decide, DECISIONS_MODEL } from './admission/positioningGate';

/*
 * BILL-BYOK (Owner 2026-11-07) on every settlement path: the live receipt (whole JSON and streamed), the recovery lookup, the
 * positioning check, and the BYOK key OpenRouter fell back from. The user's base (nominal_usd, the frozen list price of the tokens)
 * is the same with or without BYOK; actual_usd, the platform's cost, is OpenRouter's fee plus the vendor's upstream charge.
 * The ledger side (duplicate receipts, races, stop-loss) is packages/db/tests/turn-core/byok-local.mjs.
 */
const limits = { providerSlug: 'anthropic', contextTokens: 10000, promptUsdPerMillion: '2', completionUsdPerMillion: '10', requestUsd: '0' };
const identity = { provider: 'openrouter' as const, account: 'test', model: 'test/model', protocol: 'openrouter-chat-v1' as const,
  providerLimits: limits, outputLimit: 100, upperUsd: openRouterBound(limits, 100).upperUsd };
const pricing = { version: 'nominal-v1' as const, pricingHash: 'a'.repeat(64), endpointTag: 'anthropic',
  tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }], timeOfDay: [] };
const call: ModelCall = { modelId: '10000000-0000-4000-8000-000000000001', identity, upperUsd: identity.upperUsd, multiplier: '6',
  concurrency: 4, pricing };
const request = (stream: boolean) => JSON.stringify({ model: identity.model, stream,
  ...(stream ? { stream_options: { include_usage: true } } : {}), store: false,
  messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, provider: openRouterBound(limits, identity.outputLimit).routing });
const BYOK = { cost: 0.0000032, is_byok: true, cost_details: { upstream_inference_cost: 0.000064 } };
// The BYOK key failed and OpenRouter served the call from its own credits: an ordinary call.
const FELL_BACK = { cost: 0.000064, is_byok: false, cost_details: { upstream_inference_cost: 0.000064 } };
const usage = (cost: Record<string, unknown>) => ({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, ...cost });
const completion = (cost: Record<string, unknown>) => JSON.stringify({ id: 'gen-1', object: 'chat.completion', created: 1,
  model: identity.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: usage(cost) });
const sse = (cost: Record<string, unknown>) => [
  { id: 'gen-1', model: identity.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
  { id: 'gen-1', model: identity.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'gen-1', model: identity.model, choices: [], usage: usage(cost) },
].map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
const quiet = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };
const slots: CounterStore = { take: async () => 1, drop: async () => undefined };

function harness() {
  const records: Array<Record<string, unknown>> = [];
  let seq = 0;
  const db = {
    begin: vi.fn(async () => ({ state: 'running', status: 'dispatched', ...quiet })),
    identity: vi.fn(async () => ({ status: 'identified' })),
    record: vi.fn(async (a: Record<string, unknown>) => { records.push(a); return { status: a.status, creditsLow: false, ...quiet }; }),
  } as unknown as TurnDatabase;
  return { records, deps: { db, slots, actorId: 'a', turnId: 1, nextSeq: () => ++seq, sleep: async () => {} } };
}
async function live(cost: Record<string, unknown>, stream = false) {
  const h = harness();
  const transport = vi.fn(async () => stream
    ? new Response(sse(cost), { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-1' } })
    : new Response(completion(cost), { headers: { 'x-generation-id': 'gen-1' } }));
  const out = JSON.parse(await modelCall({ ...h.deps, adapter: openRouterAdapter({ credential: async () => 'KEY', transport }) }, call,
    request(stream)));
  expect(out.choices[0].message.content).toBe('hello');
  expect(transport).toHaveBeenCalledTimes(1);
  return h.records;
}
// n = (12 x 2 + 4 x 10) / 1e6 = 0.000064, the frozen list price of the tokens, BYOK or not.
const NOMINAL = '0.000064';

describe('live receipt (call.ts)', () => {
  it.each([false, true])('BYOK (stream %s): the user base is unchanged; actual = fee + upstream with the split in usage', async stream => {
    const [receipt] = await live(BYOK, stream);
    expect(receipt).toMatchObject({ status: 'ok', nominalUsd: NOMINAL, actualUsd: '0.0000672', providerId: 'gen-1',
      usage: { byok: { feeUsd: '0.0000032', upstreamUsd: '0.000064' } } });
  });
  it.each([false, true])('not BYOK, or a BYOK key OpenRouter fell back from (stream %s): exactly as before', async stream => {
    for (const cost of [{ cost: 0.000064 }, FELL_BACK]) {
      const [receipt] = await live(cost, stream);
      expect(receipt).toMatchObject({ status: 'ok', nominalUsd: NOMINAL, actualUsd: '0.000064' });
      expect(receipt!.usage).not.toHaveProperty('byok');
    }
  });
  it('BYOK without the upstream cost: the answer is delivered, no receipt is written, the call is left for recovery', async () => {
    const records = await live({ cost: 0.0000032, is_byok: true });
    expect(records).toEqual([]);
  });
  it('one turn, two calls: one served by the BYOK key, the next fell back to OpenRouter credits; each keeps its own cost', async () => {
    // The vendor's gifted credits ran out (OpenAI 429 credit_balance_exhausted) between the two calls of the same turn.
    const h = harness(), bodies = [completion(BYOK), completion(FELL_BACK).replace('"gen-1"', '"gen-2"')];
    const transport = vi.fn(async () => new Response(bodies.shift()!));
    const adapter = openRouterAdapter({ credential: async () => 'KEY', transport });
    await modelCall({ ...h.deps, adapter }, call, request(false));
    await modelCall({ ...h.deps, adapter }, call, request(false));
    expect(h.records).toHaveLength(2);
    expect(h.records[0]).toMatchObject({ seq: 1, providerId: 'gen-1', nominalUsd: NOMINAL, actualUsd: '0.0000672',
      usage: { byok: { feeUsd: '0.0000032', upstreamUsd: '0.000064' } } });
    expect(h.records[1]).toMatchObject({ seq: 2, providerId: 'gen-2', nominalUsd: NOMINAL, actualUsd: '0.000064' });
    expect(h.records[1]!.usage).not.toHaveProperty('byok');
  });
  it('the same BYOK response twice writes the identical receipt (turn_call_record treats the repeat as a no-op)', async () => {
    const [first] = await live(BYOK), [second] = await live(BYOK);
    expect(second).toEqual(first);
  });
});

describe('recovery lookup (recovery.ts)', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const observed = (body: unknown, httpStatus = 200): TransportObservation => {
    const rawBody = JSON.stringify(body);
    return { rawBody, rawBodyBase64: Buffer.from(rawBody).toString('base64'), sourceHash: createHash('sha256').update(rawBody).digest('hex'),
      httpStatus, complete: true, transportIssue: null } as TransportObservation;
  };
  const generation = (extra: Record<string, unknown>) => observed({ data: { id: 'gen-1', model: 'test/model-20261101',
    finish_reason: 'stop', native_tokens_prompt: 12, native_tokens_completion: 4, ...extra } });
  const item = (calls: RecoveryItem['calls'] = [{ seq: 1, providerId: 'gen-1', model: 'test/model', pricing, upperUsd: '0.02' }]):
    RecoveryItem => ({ actorId, turnId: 7, action: 'settle', calls });
  async function recover(lookup: TurnRecoveryDeps['lookup'], calls?: RecoveryItem['calls']) {
    const batches = [[item(calls)]];
    const db = {
      claimRecovery: vi.fn(async () => batches.shift() ?? []),
      recover: vi.fn(async () => ({ action: 'settle', settlement: 'done' as const, closeKind: 'interrupted' })),
      record: vi.fn(async () => ({ status: 'ok', creditsLow: false, ...quiet })),
      settleAbsent: vi.fn(async () => ({ settled: true })), settleNoIdentity: vi.fn(async () => ({ settled: true })),
    };
    const summary = await recoverTurns({ db: db as unknown as TurnRecoveryDeps['db'], lookup, account: 'openrouter-key:synthetic',
      deadline: 60_000, now: () => 0 });
    return { db, summary };
  }
  it('a BYOK lookup: nominal from the tokens, actual = total_cost + upstream_inference_cost, split kept', async () => {
    const { db, summary } = await recover(vi.fn(async () => generation({ total_cost: 0.0000032, is_byok: true,
      upstream_inference_cost: 0.000064 })));
    expect(db.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', nominalUsd: NOMINAL, actualUsd: '0.0000672',
      usage: expect.objectContaining({ nominalSource: 'nominal', byok: { feeUsd: '0.0000032', upstreamUsd: '0.000064' } }) }));
    expect(summary).toMatchObject({ lateReceipts: 1, settled: 1 });
  });
  it('a non-BYOK lookup is as before', async () => {
    const { db } = await recover(vi.fn(async () => generation({ total_cost: 0.000064, is_byok: false, upstream_inference_cost: 0 })));
    expect(db.record).toHaveBeenCalledWith(expect.objectContaining({ nominalUsd: NOMINAL, actualUsd: '0.000064' }));
    expect((db.record.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>])[0].usage).not.toHaveProperty('byok');
  });
  it('a BYOK lookup without the upstream cost records nothing: the cost stays unknown, nothing is presumed', async () => {
    const { db, summary } = await recover(vi.fn(async () => generation({ total_cost: 0.0000032, is_byok: true })));
    expect(db.record).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ lookups: 1, lateReceipts: 0 });
  });
  it('without token counts the fallback min(actual, U) uses the whole BYOK cost, capped by the frozen bound', async () => {
    const { db } = await recover(vi.fn(async () => observed({ data: { id: 'gen-1', model: 'test/model', finish_reason: 'stop',
      total_cost: 0.0005, is_byok: true, upstream_inference_cost: 0.01 } })));
    expect(db.record).toHaveBeenCalledWith(expect.objectContaining({ nominalUsd: '0.0105', actualUsd: '0.0105',
      usage: expect.objectContaining({ nominalSource: 'actual_fallback' }) }));
    const capped = await recover(vi.fn(async () => observed({ data: { id: 'gen-1', model: 'test/model', finish_reason: 'stop',
      total_cost: 0.005, is_byok: true, upstream_inference_cost: 0.1 } })));
    expect(capped.db.record).toHaveBeenCalledWith(expect.objectContaining({ nominalUsd: '0.02', actualUsd: '0.105' }));
  });
  it('a failed lookup (provider error) is not evidence: nothing recorded', async () => {
    const { db } = await recover(vi.fn(async () => observed({ error: { message: 'busy' } }, 503)));
    expect(db.record).not.toHaveBeenCalled();
  });
});

describe('positioning check (positioningGate.ts)', () => {
  const answer = (usage: Record<string, unknown>) => new Response(JSON.stringify({ model: DECISIONS_MODEL,
    answers: { own_account_social_media_operations: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 300, output_tokens: 1, ...usage } }));
  it.each([
    [{ cost: 0.000001, is_byok: true, cost_details: { upstream_inference_cost: 0.00002 } }, 0.000021],
    [{ cost: 0.00002, is_byok: false, cost_details: { upstream_inference_cost: 0.00002 } }, 0.00002],
    [{ cost: 0.00002 }, 0.00002],
    [{ cost: 0.000001, is_byok: true }, null],
  ] as const)('reports the platform cost %j as %s (null: the upper bound counts toward the stop-loss)', async (cost, expected) => {
    const onCost = vi.fn();
    expect(await decide('KEY', 'x', vi.fn(async () => answer(cost)) as never, undefined, onCost)).toBe('clear');
    const heard = onCost.mock.calls[0]![0];
    if (expected === null) expect(heard).toBeNull(); else expect(heard).toBeCloseTo(expected, 12);
  });
});
