/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { createRuntimeBudget, RUNTIME_WORK_MS } from '../runtime/budget';
import { modelCall, type ModelCall } from './call';
import type { CounterStore } from './limiter';
import type { TurnDatabase } from './db';

const limits = { providerSlug: 'synthetic', contextTokens: 10000, promptUsdPerMillion: '2', completionUsdPerMillion: '10', requestUsd: '0' };
const identity = { provider: 'openrouter' as const, account: 'test', model: 'test/model', protocol: 'openrouter-chat-v1' as const,
  providerLimits: limits, outputLimit: 100, upperUsd: openRouterBound(limits, 100).upperUsd };
const call: ModelCall = { modelId: '10000000-0000-4000-8000-000000000001', identity, upperUsd: identity.upperUsd, multiplier: '6',
  concurrency: 4, pricing: { version: 'nominal-v1', pricingHash: 'a'.repeat(64), endpointTag: 'synthetic/exact',
    tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }], timeOfDay: [] } };
const body = JSON.stringify({ model: identity.model, stream: false, store: false, messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 100, provider: openRouterBound(limits, identity.outputLimit).routing });
const completion = (id: string) => JSON.stringify({ id, object: 'chat.completion', created: 1, model: identity.model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: '0.003' } });
const quiet = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };
const slots: CounterStore = { incr: async () => 1, decr: async () => 0 };

function harness(over: { begin?: (seq: number) => Record<string, unknown> } = {}) {
  const writes: Array<[string, Record<string, unknown>]> = [];
  let seq = 0;
  const db = {
    begin: vi.fn(async (a: Record<string, unknown>) => { writes.push(['begin', a]);
      return { state: 'running', status: 'dispatched', ...quiet, ...over.begin?.(a.seq as number) }; }),
    identity: vi.fn(async (a: Record<string, unknown>) => { writes.push(['identity', a]); return { status: 'identified' }; }),
    record: vi.fn(async (a: Record<string, unknown>) => { writes.push(['record', a]); return { status: a.status, creditsLow: false, ...quiet }; }),
  } as unknown as TurnDatabase;
  return { writes, deps: { db, slots, actorId: 'a', turnId: 1, nextSeq: () => ++seq, sleep: async () => {} } };
}
const kinds = (writes: Array<[string, Record<string, unknown>]>) => writes.map(([k, a]) => k + (a.status ? ':' + a.status : ''));

describe('one model call, three writes (CORE-PATH-V2 2.5.2)', () => {
  it('writes begin before sending, the provider id, then the final receipt with the nominal cost and the full response', async () => {
    const h = harness(), transport = vi.fn(async () => new Response(completion('gen-1'), { headers: { 'x-generation-id': 'gen-1' } }));
    const adapter = openRouterAdapter({ credential: async () => 'KEY', transport });
    const out = JSON.parse(await modelCall({ ...h.deps, adapter }, call, body));
    expect(out.choices[0].message.content).toBe('hello');
    expect(kinds(h.writes)).toEqual(['begin', 'identity', 'record:ok']);
    const receipt = h.writes[2]![1];
    // n = (10 x 2 + 4 x 10) / 1e6 = 0.00006 from the frozen nominal prices (USD per million tokens); c = the provider's 0.003.
    expect(receipt).toMatchObject({ seq: 1, nominalUsd: '0.00006', actualUsd: '0.003', providerId: 'gen-1' });
    expect(receipt.raw).toBe(completion('gen-1'));
    expect(receipt.usage).not.toHaveProperty('sdkResponse');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('a 402 costs nothing and stops the turn', async () => {
    const h = harness(), transport = vi.fn(async () => new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits',
      metadata: { limit_source: 'openrouter_credits' } } }), { status: 402 }));
    await expect(modelCall({ ...h.deps, adapter: openRouterAdapter({ credential: async () => 'KEY', transport }) }, call, body))
      .rejects.toThrow('TURN_PROVIDER_402');
    expect(kinds(h.writes)).toEqual(['begin', 'record:no_charge_402']);
  });

  it('a stream broken after it started keeps the provider id, sends nothing again and records no receipt', async () => {
    const h = harness();
    const transport = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"gen-2","choi'));
      controller.error(new Error('connection lost'));
    } }), { headers: { 'x-generation-id': 'gen-2' } }));
    await expect(modelCall({ ...h.deps, adapter: openRouterAdapter({ credential: async () => 'KEY', transport }) }, call, body))
      .rejects.toThrow('TURN_CALL_UNKNOWN');
    expect(kinds(h.writes)).toEqual(['begin', 'identity']);
    expect(h.writes[1]![1]).toMatchObject({ providerId: 'gen-2' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('a short freeze or a tombstone stops before anything is sent', async () => {
    for (const [patch, code] of [[{ paused: true, state: 'paused' }, 'TURN_PAUSED_FOR_CREDITS'],
      [{ sessionTombstoned: true }, 'TURN_TOMBSTONED']] as const) {
      const h = harness({ begin: () => patch }), transport = vi.fn();
      await expect(modelCall({ ...h.deps, adapter: openRouterAdapter({ credential: async () => 'KEY', transport }) }, call, body))
        .rejects.toThrow(code);
      expect(transport).not.toHaveBeenCalled();
      expect(kinds(h.writes)).toEqual(['begin']);
    }
  });

  it('only an attempt proven unsent is retried, as a new row; a request the whitelist refuses is not', async () => {
    // A real time budget on a clock we move: right after the first preparation the clock nears the deadline, so the send is
    // refused by the budget before the transport (proven unsent); the retry prepares at a fresh time and goes through.
    let t = 0, prepared = 0;
    const budget = createRuntimeBudget(() => t);
    const h = harness(), transport = vi.fn(async () => new Response(completion('gen-3'), { headers: { 'x-generation-id': 'gen-3' } }));
    const real = openRouterAdapter({ credential: async () => 'KEY', transport, budget });
    const adapter = { prepareDispatch: async (...args: Parameters<typeof real.prepareDispatch>) => {
      t = 0; const send = await real.prepareDispatch(...args);
      if (++prepared === 1) t = RUNTIME_WORK_MS - 1000;
      return send;
    } };
    await modelCall({ ...h.deps, adapter }, call, body);
    expect(kinds(h.writes)).toEqual(['begin', 'record:not_sent', 'begin', 'identity', 'record:ok']);
    expect(h.writes.filter(([k]) => k === 'begin').map(([, a]) => a.seq)).toEqual([1, 2]);
    expect(transport).toHaveBeenCalledTimes(1);

    const denied = harness(), never = vi.fn();
    await expect(modelCall({ ...denied.deps, adapter: openRouterAdapter({ credential: async () => 'KEY', transport: never }) }, call,
      JSON.stringify({ ...JSON.parse(body), tools: [{}] }))).rejects.toThrow('TURN_CALL_DENIED');
    expect(kinds(denied.writes)).toEqual(['begin', 'record:not_sent']);
    expect(never).not.toHaveBeenCalled();
  });
});
