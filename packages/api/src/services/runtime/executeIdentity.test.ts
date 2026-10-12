/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { createRuntimeBudget } from './budget';
import { BRAND_REPLY_ZH } from '../modelIdentity/brandIdentity';
import type { RuntimeProgress } from './progress';
const mock = vi.hoisted(() => ({ run: vi.fn(), billing: {
  claimCall: vi.fn(), dispatchOnce: vi.fn(), recoverRun: vi.fn(), recoverReceipts: vi.fn(),
} }));
vi.mock('../bill2/service', () => ({ authoritativeBilling: () => mock.billing }));
vi.mock('./runner', () => ({ runRuntime: mock.run }));
vi.mock('./session', () => ({ PostgresSession: class {} }));
const id = '10000000-0000-4000-8000-000000000001';
const LEAK = '我是由 Google 训练的大型语言模型。下面是三个选题建议。';

// MODEL-IDENTITY-GUARD layer 3 through the real executor: streamed and stored text agree.
function fixture(enabled: boolean | 'unreadable') {
  const raw = new Map<number, string>();
  const policy = { modelId: id, provider: 'fixture', account: 'synthetic', model: 'primary', protocol: 'fixture-cost-v1',
    upperUsd: '0.02', inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true };
  const execution = { state: 'running', live: true, cancelRequested: false, runId: id, sessionId: id,
    context: { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: '你是谁', instructions: 'Answer',
      model: 'primary', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny' },
    billing: { callPolicy: [policy], rules: {}, limits: { maxCalls: 1 } }, result: null };
  const completed: unknown[] = [];
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'model_identity_guard_config') return enabled === 'unreadable' ? { data: null, error: { code: 'XX000' } }
      : { data: { version: 1, enabled, revision: 0, updatedBy: null, updatedAt: null }, error: null };
    if (name === 'runtime_execution' && args.p_action === 'begin') return { data: execution, error: null };
    if (name === 'runtime_execution' && args.p_action === 'complete') completed.push(args.p_result);
    if (name === 'runtime_response') return { data: { rawBody: raw.get(Number(args.p_sequence)) ?? null }, error: null };
    return { data: { state: 'completed', runId: id }, error: null };
  }) };
  mock.billing.claimCall.mockImplementation(async (_runId, sequence) => ({ id: String(sequence) }));
  mock.billing.dispatchOnce.mockImplementation(async (callId, request) => {
    raw.set(Number(callId), JSON.stringify({ usage: { sdkResponse: { model: JSON.parse(request).model,
      choices: [{ message: { content: LEAK } }] } } }));
    return { dispatched: true };
  });
  mock.run.mockImplementation(async options => {
    await options.exchange(1, JSON.stringify({ model: options.model }));
    return LEAK;
  });
  const options = { database, actor: async () => id, adapter: { dispatch: vi.fn() } as never,
    callGate: vi.fn().mockResolvedValue({ ok: true }), budget: createRuntimeBudget() };
  return { options, completed, database };
}
beforeEach(() => vi.clearAllMocks());

it.each([true, 'unreadable'] as const)('switch %s: the stored and returned reply carry the brand reply, not the vendor', async enabled => {
  const f = fixture(enabled), events: RuntimeProgress[] = [];
  const result = await runtimeExecutor(f.options).execute(id, event => events.push(event));
  const expected = `${BRAND_REPLY_ZH}下面是三个选题建议。`;
  expect(result).toMatchObject({ state: 'completed', body: expected });
  expect(f.completed).toHaveLength(1);
  expect((f.completed[0] as { body: string }).body).toBe(expected);
  expect(JSON.stringify(events)).not.toMatch(/Google/);
});

it('switch off: the reply is stored as the model wrote it', async () => {
  const f = fixture(false);
  expect(await runtimeExecutor(f.options).execute(id)).toMatchObject({ state: 'completed', body: LEAK });
});
