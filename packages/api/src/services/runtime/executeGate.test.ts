/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { NativeProgressProjection } from './nativeProgress';
import { allowAllModeration } from './moderation';
import { createRuntimeBudget } from './budget';
import type { NewWorkGateResult } from './newWorkGate';
const mock = vi.hoisted(() => ({ run: vi.fn(), billing: {
  claimCall: vi.fn(), dispatchOnce: vi.fn(), recoverRun: vi.fn(), recoverReceipts: vi.fn(),
} }));
vi.mock('../bill2/service', () => ({ authoritativeBilling: () => mock.billing }));
vi.mock('./runner', () => ({ runRuntime: mock.run }));
vi.mock('./session', () => ({ PostgresSession: class {} }));
const id = '10000000-0000-4000-8000-000000000001';
const organizerId = '10000000-0000-4000-8000-000000000002';
function fixture(organize = true) {
  const raw = new Map<number, string>();
  const policy = { modelId: id, provider: 'fixture', account: 'synthetic', model: 'primary', protocol: 'fixture-cost-v1',
    upperUsd: '0.02', inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true };
  const execution = { state: 'running', live: true, cancelRequested: false, runId: id, sessionId: id,
    context: { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'input', instructions: 'Answer',
      model: 'primary', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny',
      ...(organize ? { attachedOrganizer: { modelId: organizerId, model: 'organizer', maxOutputTokens: 1000 } } : {}) },
    billing: { callPolicy: [policy, { ...policy, modelId: organizerId, model: 'organizer' }],
      rules: {}, limits: { maxCalls: organize ? 2 : 3 } },
    result: null as null | { body: string; summary?: string },
  };
  let cancelFails = false, failBeforeFails = false;
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'runtime_execution' && args.p_action === 'begin') return { data: execution, error: null };
    if (name === 'runtime_response') return { data: { rawBody: raw.get(Number(args.p_sequence)) ?? null }, error: null };
    if (name === 'runtime_cancel') return cancelFails ? { data: null, error: {} } : { data: { state: 'cancelled' }, error: null };
    if (args.p_action === 'fail_before_dispatch') return failBeforeFails ? { data: null, error: {} }
      : { data: { state: 'cancelled' }, error: null };
    return { data: { state: 'completed', runId: id }, error: null };
  }) };
  const gate = vi.fn<() => Promise<NewWorkGateResult>>().mockResolvedValue({ ok: true });
  const budget = createRuntimeBudget();
  const timing = budget.timing;
  const options = { database, actor: async () => id, adapter: { dispatch: vi.fn() } as never,
    callGate: gate, budget };
  mock.billing.claimCall.mockImplementation(async (_runId, sequence) => ({ id: String(sequence) }));
  mock.billing.dispatchOnce.mockImplementation(async (callId, request) => {
    const model = JSON.parse(request).model;
    raw.set(Number(callId), JSON.stringify({ usage: { sdkResponse: { model, choices: [{ message: { content: 'reply' } }] } } }));
    return { dispatched: true };
  });
  mock.run.mockImplementation(async options => {
    try { await options.exchange(1, JSON.stringify({ model: options.model })); }
    catch { throw new Error('SDK_WRAPPED_ERROR'); }
    return options.model === 'organizer' ? 'summary' : 'body';
  });
  return { execution, raw, database, gate, options, timing,
    cancelFails: () => { cancelFails = true; }, failBeforeFails: () => { failBeforeFails = true; } };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
it('requires a gate at construction even through an untyped caller', () => {
  expect(() => runtimeExecutor({} as never)).toThrow('RUNTIME_CALL_GATE_REQUIRED');
});
it.each(['call_limited', 'paused', 'limit_unavailable'] as const)('retains %s through SDK wrapping before any claim or dispatch', async reason => {
  const f = fixture(); f.gate.mockResolvedValue({ ok: false, reason, retryAfter: 60 });
  expect(await runtimeExecutor(f.options).execute(id)).toEqual({ state: 'cancelled', unavailable: reason });
  expect(mock.billing.claimCall).not.toHaveBeenCalled(); expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
  expect(f.database.rpc.mock.calls.some(([, args]) => args.p_action === 'fail_before_dispatch')).toBe(true);
  expect(f.database.rpc.mock.calls.some(([, args]) => args.p_action === 'interrupt')).toBe(false);
});
it('unexpected gate failure fails closed and ambiguous cancellation stays recoverable', async () => {
  const f = fixture(); f.gate.mockRejectedValue(new Error('private'));
  expect(await runtimeExecutor(f.options).execute(id)).toEqual({ state: 'cancelled', unavailable: 'limit_unavailable' });
  f.failBeforeFails();
  expect(await runtimeExecutor(f.options).execute(id)).toEqual({ state: 'pending' });
  expect(mock.billing.claimCall).not.toHaveBeenCalled();
});
it('precharges the frozen budget once, finishes both calls, and checks complete output once', async () => {
  const f = fixture();
  f.gate.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'paused', retryAfter: 60 });
  const moderation = vi.spyOn(allowAllModeration, 'checkOutput');
  expect(await runtimeExecutor(f.options).execute(id)).toEqual({ state: 'completed', body: 'body', summary: 'summary' });
  expect(f.gate).toHaveBeenCalledExactlyOnceWith(id, 2, 'bill2.v1');
  expect(mock.billing.claimCall).toHaveBeenCalledTimes(2); expect(mock.billing.dispatchOnce).toHaveBeenCalledTimes(2);
  expect(moderation).toHaveBeenCalledExactlyOnceWith({ actorId: id, executionId: id, body: 'body', summary: 'summary' });
  expect(f.timing.summary().phases.rateLimit).toBeDefined();
});
it.each(['completed', 'cost_pending', 'cancelled', 'cancelRequested', 'replay', 'financial'])('%s never counts or moderates again', async mode => {
  const f = fixture(false);
  const moderation = vi.spyOn(allowAllModeration, 'checkOutput');
  if (mode === 'cancelRequested') f.execution.cancelRequested = true;
  else if (mode === 'replay') {
    f.execution.live = false;
    f.raw.set(1, JSON.stringify({ usage: { sdkResponse: { model: 'primary', choices: [{}] } } }));
  } else f.execution.state = mode;
  if (['completed', 'cost_pending'].includes(mode)) f.execution.result = { body: 'saved' };
  const executor = runtimeExecutor(f.options);
  if (mode === 'financial') await executor.recoverFinancial(id);
  else await executor.execute(id);
  expect(f.gate).not.toHaveBeenCalled(); expect(moderation).not.toHaveBeenCalled();
  expect(mock.billing.claimCall).not.toHaveBeenCalled(); expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
});
it.each(['block', 'throw'])('output moderation %s cancels without saving or pending', async mode => {
  const f = fixture(); const moderation = vi.spyOn(allowAllModeration, 'checkOutput');
  if (mode === 'block') moderation.mockResolvedValue({ action: 'block', category: 'synthetic' });
  else moderation.mockRejectedValue(new Error('private'));
  expect(await runtimeExecutor(f.options).execute(id)).toEqual({ state: 'cancelled' });
  expect(mock.billing.dispatchOnce).toHaveBeenCalledTimes(2);
  expect(f.database.rpc.mock.calls.some(([, args]) => ['complete', 'interrupt'].includes(String(args.p_action)))).toBe(false);
});
it('a moderation cancellation storage failure propagates without blind retry or pending', async () => {
  const f = fixture(); f.cancelFails();
  vi.spyOn(allowAllModeration, 'checkOutput').mockRejectedValue(new Error('private'));
  await expect(runtimeExecutor(f.options).execute(id)).rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
  expect(f.database.rpc.mock.calls.filter(([name]) => name === 'runtime_cancel')).toHaveLength(1);
});

it('forwards every native frame to the SDK even when public projection throws', async () => {
  const f = fixture(false);
  Object.assign(f.execution.context, { nativeOutput: 'native-output-v1', envelopeOrder: 'message-first-v1',
    providerRequestFormat: 'serial-tools-v4-stream', reasoning: { effort: 'none' } });
  const body = '{"message":"kept reply"}';
  const chunks = [body.slice(0, 15), body.slice(15)];
  const frames = chunks.map(content => JSON.stringify({ choices: [{ delta: { content } }] }));
  const received: string[] = [];
  const project = vi.spyOn(NativeProgressProjection.prototype, 'appendText')
    .mockImplementationOnce(() => {
      expect(received).toEqual([frames[0]]);
      throw new Error('synthetic private projection failure');
    });
  mock.billing.dispatchOnce.mockImplementation(async (callId, _request, onChunk) => {
    for (const frame of frames) onChunk(frame);
    f.raw.set(Number(callId), JSON.stringify({ usage: { sdkResponse: {
      model: 'primary', choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
    } } }));
    return { dispatched: true };
  });
  mock.run.mockImplementation(async options => {
    await options.exchange(1, JSON.stringify({ model: options.model }), (frame: string) => received.push(frame));
    return received.map(frame => JSON.parse(frame).choices[0].delta.content).join('');
  });
  const progress = vi.fn();
  const result = await runtimeExecutor(f.options).execute(id, progress);
  expect(result).toMatchObject({ state: 'completed', body, completeness: 'complete' });
  expect(received).toEqual(frames);
  expect(project).toHaveBeenCalledTimes(2);
  expect(f.database.rpc.mock.calls.find(([, args]) => args.p_action === 'complete')?.[1].p_result)
    .toMatchObject({ body, completeness: 'complete' });
  expect(progress.mock.calls.filter(([event]) => event.type === 'text').at(-1)?.[0])
    .toMatchObject({ text: 'kept reply', replace: true });
});
