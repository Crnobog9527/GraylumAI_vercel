/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeExecutor } from './execute';
import { createRuntimeBudget } from './budget';
const mock = vi.hoisted(() => ({ run: vi.fn(), billing: {
  claimPaygCall: vi.fn(), dispatchOnce: vi.fn(), finalizeRun: vi.fn(), recoverRun: vi.fn(), recoverReceipts: vi.fn(),
} }));
vi.mock('../bill2/service', () => ({ authoritativeBilling: () => mock.billing }));
vi.mock('./runner', () => ({ runRuntime: mock.run }));
vi.mock('./session', () => ({ PostgresSession: class {} }));
const id = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
function fixture() {
  const policy = (modelId: string, model: string) => ({ modelId, model, provider: 'fixture', account: 'local',
    protocol: 'fixture-cost-v1', multiplier: '1', inputLimit: 32000, outputLimit: 1000, upperUsd: '1',
    automaticRetry: false, hiddenTools: false, lookupSupported: true,
    providerLimits: { providerSlug: 'local', contextTokens: 100000, promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' },
    payg: { version: '1', policyId: 'local', profileVersion: '1', evidenceVersion: '1', pricingHash: 'a'.repeat(64),
      endpointTag: 'local', templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture', maxBytes: 32000,
      maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['ordinary', 'attached_organizer'],
      expiresAt: '2099-01-01T00:00:00Z', nominalPricing: { version: 'nominal-v1', pricingHash: 'a'.repeat(64),
        endpointTag: 'local', tiers: [{ minPromptTokens: 0, prompt: '1', completion: '1', request: '0' }], timeOfDay: [] } } });
  const execution = { executionId: id, state: 'running', live: true, cancelRequested: false, runId: id, sessionId: id,
    cursor: 0, epoch: 1, remainingCalls: 2, primaryResult: undefined as {body:string}|undefined,
    context: { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'input', instructions: 'Answer',
      model: 'primary', maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny',
      attachedOrganizer: { modelId: otherId, model: 'organizer', maxOutputTokens: 1000 } },
    billing: { contractVersion: 'bill2.v2', mode: 'isolated', callPolicy: [policy(id, 'primary'), policy(otherId, 'organizer')],
      limits: { maxCalls: 2 }, rules: { creditsPerUsd: '100', billingUnit: { models: {
        [id]: { multiplier: '1', source: 'global' }, [otherId]: { multiplier: '1', source: 'global' } } } } }, result: null };
  const raw = new Map<number, string>();
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'runtime_response') return { data: { rawBody: raw.get(Number(args.p_sequence)) ?? null }, error: null };
    if (args.p_action === 'payg_resume') Object.assign(execution, { state: 'running', live: true, epoch: execution.epoch + 1 });
    if (args.p_action === 'payg_wait') Object.assign(execution, { state: (args.p_result as {state:string}).state,
      cursor: execution.cursor + 1, live: false, remainingCalls: 2 - raw.size });
    if (args.p_action === 'checkpoint_primary') execution.primaryResult = (args.p_result as {value:{body:string}}).value;
    if (args.p_action === 'complete') return { data: { state: 'completed' }, error: null };
    return { data: structuredClone(execution), error: null };
  }) };
  let balance = false;
  mock.billing.claimPaygCall.mockImplementation(async (_run, sequence) => sequence === 2 && !balance
    ? { id: null, state: 'waiting_credits' } : { id: String(sequence), state: 'prepared' });
  mock.billing.dispatchOnce.mockImplementation(async (callId, request) => {
    raw.set(Number(callId), JSON.stringify({ usage: { sdkResponse: { model: JSON.parse(request).model,
      choices: [{ message: { content: 'reply' } }] } } }));
    return { dispatched: true };
  });
  mock.run.mockImplementation(async options => {
    try { await options.exchange(1, JSON.stringify({ model: options.model, messages: [{ role: 'user', content: options.input }] })); }
    catch { throw Error('SDK_WRAPPED_ERROR'); }
    return options.model === 'organizer' ? 'summary' : 'body';
  });
  const gate = vi.fn(async () => ({ ok: true as const }));
  return { execution, database, raw, gate, fund: () => { balance = true; },
    options: { database, actor: async () => id, callGate: gate, adapter: { dispatch: vi.fn() } as never } };
}
afterEach(() => vi.clearAllMocks());
it('persists organizer waiting despite SDK wrapping; resume replays the saved prefix and charges only the next call', async () => {
  const f = fixture();
  const first = await runtimeExecutor(f.options).execute(id);
  expect(first).toMatchObject({ state: 'waiting_credits', code: 'RUNTIME_WAITING_CREDITS', cursor: 1, epoch: 1,
    remainingCalls: 1, body: 'body' });
  expect(mock.billing.dispatchOnce).toHaveBeenCalledTimes(1);
  expect(f.database.rpc.mock.calls.some(([, a]) => a.p_action === 'fail_before_dispatch')).toBe(false);
  f.fund();
  const result = await runtimeExecutor(f.options).execute(id, undefined, { executionId: id, cursor: 1, epoch: 1 });
  expect(result).toMatchObject({ state: 'completed', body: 'body', summary: 'summary' });
  expect(mock.billing.dispatchOnce.mock.calls.map(([id]) => id)).toEqual(['1', '2']);
  expect(f.gate.mock.calls.map((args: unknown[]) => args[1])).toEqual([2, 1]);
  expect(f.database.rpc.mock.calls.filter(([, a]) => a.p_action === 'checkpoint_primary')
    .map(([, a]) => (a.p_result as {epoch:number}).epoch)).toEqual([1, 2]);
  expect(f.database.rpc.mock.calls.find(([, a]) => a.p_action === 'complete')?.[1].p_result)
    .toMatchObject({epoch:2,value:{body:'body',summary:'summary'}});
});
it('time exhaustion before the next call is waiting_resume, never cancellation or automatic continuation', async () => {
  const f = fixture();
  let now = 0;
  const budget = createRuntimeBudget(() => now);
  now = 266000;
  const result = await runtimeExecutor({ ...f.options, budget }).execute(id);
  expect(result).toMatchObject({ state: 'waiting_resume', code: 'RUNTIME_WAITING_RESUME', remainingCalls: 2 });
  expect(mock.billing.claimPaygCall).not.toHaveBeenCalled();
  expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
  expect(f.database.rpc.mock.calls.some(([, a]) => a.p_action === 'fail_before_dispatch')).toBe(false);
});
it('time exhausted after claim preserves task and atomically retires its prepared call through payg_wait',async()=>{
 const f=fixture();let now=0;
 const budget=createRuntimeBudget(()=>now);
 mock.billing.claimPaygCall.mockImplementation(async()=>{now=266000;return {id:'1',state:'prepared'};});
 expect(await runtimeExecutor({...f.options,budget}).execute(id)).toMatchObject({state:'waiting_resume'});
 expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
 expect(f.database.rpc.mock.calls.find(([,a])=>a.p_action==='payg_wait')?.[1].p_result)
  .toMatchObject({sequence:1,state:'waiting_resume'});
 expect(f.database.rpc.mock.calls.some(([,a])=>a.p_action==='fail_before_dispatch')).toBe(false);
});
it('public cancellation and financial recovery do not acquire or reuse a runtime owner epoch', async () => {
  const f = fixture(), host = runtimeExecutor(f.options);
  await host.cancel(id);
  expect(f.database.rpc).toHaveBeenLastCalledWith('runtime_cancel', { p_execution_id: id, p_actor_id: id });
  await host.recoverFinancial(id);
  expect(f.database.rpc.mock.calls.filter(([name]) => name === 'runtime_financial_recovery').map(([, args]) => args))
    .toEqual([{ p_execution_id: id, p_actor_id: id }, { p_execution_id: id, p_actor_id: id, p_finish: true }]);
  expect(f.database.rpc.mock.calls.some(([, args]) => args.p_action === 'owner_cancel')).toBe(false);
});
it('a suspended epoch-1 owner cannot fail or interrupt the resumed epoch-2 execution', async () => {
  const f = fixture();
  let reachedGate!: () => void, releaseGate!: () => void;
  const gated = new Promise<void>(resolve => { reachedGate = resolve; });
  const released = new Promise<void>(resolve => { releaseGate = resolve; });
  const current = { epoch: 1, state: 'running', hold: 0, session: ['primary'] };
  const ownerWrites: Array<{ action: string; epoch: unknown }> = [];
  const database = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'runtime_cancel') {
      current.state = 'cancelled'; current.hold = 0;
    }
    if (name === 'runtime_execution' && ['fail_before_dispatch', 'interrupt'].includes(String(args.p_action))) {
      const epoch = (args.p_result as { epoch?: unknown } | undefined)?.epoch;
      ownerWrites.push({ action: String(args.p_action), epoch });
      if (epoch !== current.epoch) return { data: null, error: { message: 'RUNTIME_RESUME_CONFLICT' } };
      current.state = args.p_action === 'interrupt' ? 'interrupted' : 'cancelled';
      current.hold = 0;
    }
    return f.database.rpc(name, args);
  }) };
  const callGate = async () => {
    reachedGate();
    await released;
    throw new Error('synthetic delayed gate failure');
  };
  const oldRequest = runtimeExecutor({ ...f.options, database, callGate }).execute(id);
  await gated;
  expect(f.database.rpc.mock.calls[0]?.[1].p_action).toBe('begin');
  // Another HTTP invocation has already committed resume and reserved its next call.
  Object.assign(f.execution, { epoch: 2, state: 'running', live: true });
  Object.assign(current, { epoch: 2, hold: 12, session: ['primary', 'new owner input'] });
  const resumed = structuredClone(current);
  releaseGate();
  expect(await oldRequest).toEqual({ state: 'pending' });
  expect(ownerWrites).toEqual([
    { action: 'fail_before_dispatch', epoch: 1 }, { action: 'interrupt', epoch: 1 },
  ]);
  expect(current).toEqual(resumed);
  expect(database.rpc.mock.calls.some(([name]) => name === 'runtime_cancel')).toBe(false);
  expect(mock.billing.claimPaygCall).not.toHaveBeenCalled();
  expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
});

it.each(['first', 'organizer', 'uncertain'] as const)('keeps a safe claim reason through SDK wrapping: %s', async mode => {
  const f = fixture(); f.fund();
  const { BillingClaimRejection } = await import('../bill2/claimFailure');
  const claim = mock.billing.claimPaygCall.getMockImplementation()!;
  mock.billing.claimPaygCall.mockImplementation(async (...args) => {
    if (mode !== 'organizer' || args[1] === 2) throw new BillingClaimRejection('BILL2_START_THRESHOLD_UNCONFIGURED');
    return claim(...args);
  });
  const rpc = f.database.rpc.getMockImplementation()!;
  f.database.rpc.mockImplementation(async (name, args) => {
    if (args.p_action === 'fail_before_dispatch') return mode === 'first'
      ? { data: { state: 'cancelled' } as never, error: null }
      : { data: null as never, error: { message: 'private database detail' } as never };
    return rpc(name, args);
  });
  const result = await runtimeExecutor(f.options).execute(id);
  expect(result).toMatchObject({ state: mode === 'first' ? 'cancelled' : 'pending',
    notice: '计费配置待处理，暂时无法继续，请稍后重试或联系管理员。' });
  expect(JSON.stringify(result)).not.toMatch(/BILL2_|private database/);
  expect(mock.billing.dispatchOnce).toHaveBeenCalledTimes(mode === 'organizer' ? 1 : 0);
  expect(f.database.rpc.mock.calls.filter(([, args]) => args.p_action === 'fail_before_dispatch')).toHaveLength(1);
});

it('unknown claim errors never become public notices', async () => {
  const f = fixture();
  mock.billing.claimPaygCall.mockRejectedValue(new Error('private SQL detail'));
  const result = await runtimeExecutor(f.options).execute(id);
  expect(result).not.toHaveProperty('notice');
  expect(JSON.stringify(result)).not.toContain('private SQL');
  expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
});

it.each(['RUNTIME_NEW_CALLS_STOPPED', 'RUNTIME_USER_DAILY_USD_LIMIT', 'RUNTIME_SITE_DAILY_USD_LIMIT'])(
  'returns stable stop-loss code through SDK wrapping: %s', async reason => {
    const f = fixture(); f.fund();
    const { BillingClaimRejection } = await import('../bill2/claimFailure');
    mock.billing.claimPaygCall.mockRejectedValue(new BillingClaimRejection(reason));
    const result = await runtimeExecutor(f.options).execute(id);
    expect(result).toMatchObject({ code: reason });
    expect(result).toMatchObject({ notice: expect.stringMatching(/[\u4e00-\u9fff]/) });
    expect(mock.billing.dispatchOnce).not.toHaveBeenCalled();
  });
