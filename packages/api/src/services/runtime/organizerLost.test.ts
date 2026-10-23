/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { organizerExchange, responsePending, ORGANIZER_OUTPUT_LOST } from './organizerLost';
import { runtimeExecutor } from './execute';
import { createRuntimeBudget } from './budget';
import { logger } from '../../lib/logger';
const mock = vi.hoisted(() => ({ run: vi.fn(), billing: {
  claimCall: vi.fn(), dispatchOnce: vi.fn(), recoverRun: vi.fn(), recoverReceipts: vi.fn(), finalizeRun: vi.fn(),
} }));
vi.mock('../bill2/service', () => ({ authoritativeBilling: () => mock.billing }));
vi.mock('./runner', () => ({ runRuntime: mock.run }));
vi.mock('./session', () => ({ PostgresSession: class {} }));
const id = '10000000-0000-4000-8000-000000000001';
const organizerId = '10000000-0000-4000-8000-000000000002';
afterEach(() => vi.clearAllMocks());

function helper(stored: Array<{ callId?: string; state?: string; rawBody?: string | null } | null>) {
  const billing = { finalizeRun: vi.fn(async () => undefined), recoverReceipts: vi.fn(async () => undefined) };
  const rpc = vi.fn(async () => stored.shift() ?? null) as never;
  return { billing, rpc, call: organizerExchange('openrouter-chat-v1', true, id, billing, rpc, { p_execution_id: id }) };
}

it('a responded organizer call without a body is lost, and only that round reads as lost', async () => {
  const warn = vi.spyOn(logger, 'warn');
  const h = helper([]);
  await expect(h.call.recover(responsePending({ callId: 'c', state: 'responded', rawBody: null }, 2, 'h')))
    .rejects.toThrow(ORGANIZER_OUTPUT_LOST);
  expect(h.billing.recoverReceipts).not.toHaveBeenCalled();
  // Identifiers only: no reply text or user content in the log.
  expect(warn).toHaveBeenCalledExactlyOnceWith('api', 'runtime_organizer_output_lost', { executionId: id, callId: 'c', sequence: 2,
    phase: 'attached_organizer', code: ORGANIZER_OUTPUT_LOST });
  expect(await h.call.summary(async () => { throw new Error('RUNTIME_EXECUTION_PENDING'); })).toEqual({ lost: true });
  const fresh = helper([]);
  await expect(fresh.call.summary(async () => { throw new Error('RUNTIME_EXECUTION_PENDING'); })).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
});

it('an organizer call in flight gets one receipt recovery; a body stored by then is used', async () => {
  const body = JSON.stringify({ model: 'organizer', choices: [{ message: { content: 'summary' } }] });
  const h = helper([{ callId: 'c', state: 'responded', rawBody: body }]);
  const envelope = await h.call.recover(responsePending({ callId: 'c', state: 'unknown', rawBody: null }, 2, 'h'));
  expect(h.billing.recoverReceipts).toHaveBeenCalledExactlyOnceWith(id, { callId: 'c' });
  expect(h.billing.finalizeRun).toHaveBeenCalledExactlyOnceWith(id);
  expect(envelope).toEqual({ usage: { sdkResponse: JSON.parse(body) } });
});

it('anything other than a billed call keeps the original error (financial recovery owns it)', async () => {
  for (const saved of [{ callId: 'c', state: 'unknown', rawBody: null }, { callId: 'c', state: 'cancelled', rawBody: null }, null]) {
    const h = helper([saved]);
    const original = responsePending(saved, 2, 'h');
    await expect(h.call.recover(original)).rejects.toBe(original);
  }
  const plain = new Error('RUNTIME_PROVIDER_REJECTED');
  await expect(helper([]).call.recover(plain)).rejects.toBe(plain);
});

it.each([true, false])('a live turn whose organizer body was lost completes as not organized (native %s)', async native => {
  // staging 2026-10-23: the provider finished; only a cost-only lookup reached BILL2.
  const policy = { modelId: id, provider: 'fixture', account: 'synthetic', model: 'primary', protocol: 'fixture-cost-v1',
    upperUsd: '0.02', inputLimit: 32000, outputLimit: 1000, automaticRetry: false, hiddenTools: false, lookupSupported: true };
  const execution = { state: 'running', live: true, cancelRequested: false, runId: id, sessionId: id, result: null,
    context: { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'input', instructions: 'Answer',
      model: 'primary', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny',
      ...(native ? { nativeOutput: 'native-output-v1', envelopeOrder: 'message-first-v1', providerRequestFormat: 'serial-tools-v4-stream',
        reasoning: { effort: 'none' } } : {}), attachedOrganizer: { modelId: organizerId, model: 'organizer', maxOutputTokens: 1000 } },
    billing: { callPolicy: [policy, { ...policy, modelId: organizerId, model: 'organizer' }], rules: {}, limits: { maxCalls: 2 } } };
  const body = '{"message":"kept reply"}';
  const calls = new Map<number, { state: string; rawBody: string | null }>();
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'runtime_execution' && args.p_action === 'begin') return { data: execution, error: null };
    if (name === 'runtime_response') {
      const call = calls.get(Number(args.p_sequence));
      return { data: call ? { callId: String(args.p_sequence), ...call } : null, error: null };
    }
    return { data: { state: 'completed', runId: id }, error: null };
  }) };
  mock.billing.claimCall.mockImplementation(async (_runId, sequence) => ({ id: String(sequence) }));
  mock.billing.dispatchOnce.mockImplementation(async (callId, request) => {
    const model = JSON.parse(request).model;
    calls.set(Number(callId), model === 'organizer' ? { state: 'unknown', rawBody: null } : { state: 'responded', rawBody:
      JSON.stringify({ usage: { sdkResponse: { model, choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }] } } }) });
    return { dispatched: true };
  });
  mock.billing.recoverReceipts.mockImplementation(async (_runId, options: { callId: string }) => {
    calls.set(Number(options.callId), { state: 'responded', rawBody: null });
  });
  mock.run.mockImplementation(async options => {
    try { await options.exchange(1, JSON.stringify({ model: options.model })); }
    catch { throw new Error('RUNTIME_EXECUTION_PENDING'); }
    return options.model === 'organizer' ? 'summary' : body;
  });
  const result = await runtimeExecutor({ database, actor: async () => id, adapter: { dispatch: vi.fn() } as never,
    callGate: vi.fn(async () => ({ ok: true as const })), budget: createRuntimeBudget() }).execute(id);
  expect(result).toMatchObject(native ? { state: 'completed', body, organized: false } : { state: 'completed' });
  expect(mock.billing.recoverReceipts).toHaveBeenCalledExactlyOnceWith(id, { callId: '2' });
  expect(database.rpc.mock.calls.find(([, args]) => args.p_action === 'complete')?.[1].p_result)
    .toMatchObject({ summary: '', organized: false });
  expect(mock.billing.dispatchOnce).toHaveBeenCalledTimes(2);
});
