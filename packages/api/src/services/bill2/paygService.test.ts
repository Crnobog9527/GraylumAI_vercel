/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
const rebate = vi.hoisted(() => vi.fn(async (args: Record<string, unknown>) => { void args; return { status: 'already_applied' }; }));
vi.mock('../invitationRebate', () => ({ applyInvitationRebateForSpend: rebate }));
import { authoritativeBilling, type FrozenPaygRun, type FrozenRun, type FrozenCall } from './service';

const actor = randomUUID(), runId = randomUUID(), modelId = randomUUID(), callId = randomUUID();
const hash = 'a'.repeat(64);
const nominalPricing = { version: 'nominal-v1' as const, pricingHash: hash, endpointTag: 'fixture',
  tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }], timeOfDay: [] };
const common = { policyId: 'policy', profileVersion: 'profile-v1', evidenceVersion: 'fixture-v1',
  templateTokens: 4096, marginTokens: 4096, pricingHash: hash, endpointTag: 'fixture', nominalPricing };
const policy = { modelId, provider: 'fixture', account: 'synthetic', model: 'fixture/model',
  protocol: 'fixture-cost-v1' as const, upperUsd: '1', inputLimit: 196608, outputLimit: 8192,
  automaticRetry: false as const, hiddenTools: false as const, lookupSupported: true,
  payg: { ...common, version: 'v1', admissionPath: 'fixture' as const, maxBytes: 196608,
    maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['mentor'], expiresAt: '2099-01-01T00:00:00Z' } };
const value: FrozenPaygRun = { contractVersion: 'bill2.v2', mode: 'isolated',
  scope: { kind: 'positioning_draft', draftId: randomUUID() }, callPolicy: [policy],
  operation: 'question', modelId, sourceHash: hash, input: {},
  rules: { version: 'v1', quoteVersion: 'v1', creditsPerUsd: '100', multiplier: '3', fx: {},
    billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '100', defaultMultiplier: '3',
      models: { [modelId]: { multiplier: '3', source: 'global' } }, providers: {}, hash } },
  limits: { costUsd: '1', credits: 0, maxPreDeduct: 300, maxCalls: 4, deadline: '2099-01-01T00:00:00Z' } };
function setup(respond: (name: string) => unknown = () => ({ id: runId, state: 'prepared' })) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => { void args; return { data: respond(name), error: null }; });
  const adapter = { dispatch: vi.fn(), lookup: vi.fn(), prepareDispatch: vi.fn() };
  const api = authoritativeBilling({ admin: { rpc }, actor: async () => actor, adapter, rebateClient: {} });
  return { api, rpc, adapter };
}
beforeEach(() => rebate.mockClear());
it('only the explicit core v2 entry accepts zero run reservation and complete PAYG policy', async () => {
  const { api, rpc } = setup();
  await api.preparePaygRun(randomUUID(), value);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]).toEqual(['bill2_prepare', expect.objectContaining({ p_actor_id: actor,
    p_payload: expect.objectContaining({ contractVersion: 'bill2.v2', limits: expect.objectContaining({ credits: 0 }) }) })]);
  rpc.mockClear();
  const invalid = [
    { ...value, contractVersion: 'bill2.v1' },
    { ...value, limits: { ...value.limits, credits: 1 } },
    { ...value, callPolicy: [{ ...policy, payg: undefined }] },
    { ...value, rules: { ...value.rules, billingUnit: undefined } },
    { ...value, injected: true },
  ];
  for (const entry of invalid) {
    await expect(Promise.resolve().then(() => api.preparePaygRun(randomUUID(), entry as FrozenPaygRun))).rejects.toThrow();
  }
  expect(rpc).not.toHaveBeenCalled();
});
it('ordinary prepareRun rejects v2 and continues to preserve the v1 default contract', async () => {
  const { api, rpc } = setup();
  await expect(api.prepareRun(randomUUID(), value as unknown as FrozenRun)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
  const v1: FrozenRun = { ...value, contractVersion: 'bill2.v1', callPolicy: [{ ...policy, payg: undefined }],
    limits: { ...value.limits, credits: 300 } };
  await api.prepareRun(randomUUID(), v1);
  expect(rpc.mock.calls[0]?.[1].p_payload).toMatchObject({ contractVersion: 'bill2.v1', limits: { credits: 300 } });
});
function frozenCall(body: string, bytes = Buffer.byteLength(body)): FrozenCall {
  return { provider: policy.provider, account: policy.account, model: policy.model, protocol: policy.protocol,
    requestHash: createHash('sha256').update(body).digest('hex'), upperUsd: '0.1', inputLimit: 196608,
    outputLimit: 8192, automaticRetry: false, hiddenTools: false, lookupSupported: true, phase: 'mentor',
    payg: { ...common, policyVersion: 'v1', bytes, promptTokensUpper: bytes + 8192, messages: 1, tools: 0, schemaBytes: 0 } };
}
it('rejects final byte evidence mismatch before adapter preflight or durable dispatch', async () => {
  const body = JSON.stringify({ text: '中文🙂' });
  const { api, rpc, adapter } = setup(() => ({ id: callId, state: 'prepared', dispatchToken: randomUUID() }));
  await api.claimCall(runId, 1, frozenCall(body, body.length));
  await expect(api.dispatchOnce(callId, body)).rejects.toThrow('BILL2_INPUT_BOUND_CONFLICT');
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_claim']);
  expect(adapter.prepareDispatch).not.toHaveBeenCalled();
  expect(adapter.dispatch).not.toHaveBeenCalled();
});
it('maps waiting_credits to a stable error and creates no dispatch capability', async () => {
  const { api, rpc, adapter } = setup(() => ({ id: callId, state: 'waiting_credits', dispatchToken: null }));
  await expect(api.claimCall(runId, 1, frozenCall('{}'))).rejects.toThrow('BILL2_INSUFFICIENT_CREDITS');
  expect(await api.dispatchOnce(callId, '{}')).toEqual({ dispatched: false });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_claim']);
  expect(adapter.prepareDispatch).not.toHaveBeenCalled();
});
it('rebates each actual charged call using its original pre-deduct identity, never the run total', async () => {
  const first = randomUUID(), second = randomUUID(), zero = randomUUID();
  const { api, rpc } = setup(name => name === 'bill2_finalize'
    ? { id: runId, contractVersion: 'bill2.v2', state: 'settled', chargedCredits: 999, preDeductId: 'never-use-run' }
    : { id: runId, contractVersion: 'bill2.v2', state: 'settled', calls: [
      { preDeductId: first, chargedCredits: 2 }, { preDeductId: second, chargedCredits: 3 },
      { preDeductId: zero, chargedCredits: 0 }, { chargedCredits: 5 }, { preDeductId: randomUUID() },
    ] });
  await api.finalizeRun(runId);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read']);
  expect(rebate.mock.calls.map(([args]) => ({ id: args.preDeductId, credits: args.consumedCredits })))
    .toEqual([{ id: first, credits: 2 }, { id: second, credits: 3 }]);
  expect(rebate.mock.calls.every(([args]) => args.inviteeId === actor)).toBe(true);
});
it('v1 terminal rebates retain the run identity without an extra read', async () => {
  const pre = randomUUID();
  const { api, rpc } = setup(() => ({ id: runId, contractVersion: 'bill2.v1', state: 'settled', preDeductId: pre, chargedCredits: 7 }));
  await api.finalizeRun(runId);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize']);
  expect(rebate).toHaveBeenCalledWith(expect.objectContaining({ preDeductId: pre, consumedCredits: 7 }));
});

it.each(['prepared', 'cost_pending', 'refunded'])('v2 %s does not issue a premature or compensated rebate', async state => {
  const { api, rpc } = setup(() => ({ id: runId, contractVersion: 'bill2.v2', state, chargedCredits: 9 }));
  await api.finalizeRun(runId);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize']);
  expect(rebate).not.toHaveBeenCalled();
});
it('preserves a definite PAYG claim refusal and never grants a dispatch capability', async () => {
  const { api, rpc, adapter } = setup();
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'BILL2_START_THRESHOLD_UNCONFIGURED' } } as never);
  await expect(api.claimPaygCall(runId, 1, frozenCall('{}'))).rejects.toThrow('BILL2_START_THRESHOLD_UNCONFIGURED');
  expect(await api.dispatchOnce(callId, '{}')).toEqual({ dispatched: false });
  expect(adapter.dispatch).not.toHaveBeenCalled();
  expect(adapter.prepareDispatch).not.toHaveBeenCalled();
});
// 0261 transition: before the migration the database refuses a non-402 pending refusal. The same
// response is then recorded as the plain transport observation it was before, never left unrecorded.
it('falls back to the plain observation when the database predates the 403 pending refusal', async () => {
  const body = '{}', refusal = JSON.stringify({ error: { code: 403, message: 'synthetic refusal' } });
  const records: Array<{ evidenceKind?: string }> = [];
  const { api, rpc, adapter } = setup(name => name === 'bill2_dispatch' ? { dispatch: true }
    : name === 'bill2_read' ? { id: runId, state: 'cost_pending' } : { id: callId, state: 'prepared', dispatchToken: randomUUID() });
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'bill2_record') {
      const evidence = args.p_evidence as { evidenceKind?: string };
      records.push(evidence);
      if (evidence.evidenceKind === 'provider_rejection_pending')
        return { data: null, error: { message: 'BILL2_REJECTION_PROOF_DENIED' } } as never;
      return { data: { id: runId, state: 'cost_pending' }, error: null };
    }
    if (name === 'bill2_dispatch') return { data: { dispatch: true }, error: null };
    if (name === 'bill2_read') return { data: { id: runId, state: 'cost_pending' }, error: null };
    return { data: { id: callId, state: 'prepared', dispatchToken: randomUUID() }, error: null };
  });
  const bytes = Buffer.from(refusal);
  const observed = { rawBody: refusal, rawBodyBase64: bytes.toString('base64'),
    sourceHash: createHash('sha256').update(bytes).digest('hex'), httpStatus: 403, complete: true, transportIssue: null,
    generationId: 'gen-1791957271-SyntheticRefusal403' };
  adapter.prepareDispatch.mockResolvedValue(async () => observed);
  const frozen = frozenCall(body);
  await api.claimPaygCall(runId, 1, { ...frozen, provider: 'openrouter', protocol: 'openrouter-chat-v1' });
  const result = await api.dispatchOnce(callId, body);
  expect(records.map(r => r.evidenceKind)).toEqual(['provider_rejection_pending', 'transport_observation']);
  expect(result).toMatchObject({ dispatched: true, providerRejected: false });
  expect(result).not.toHaveProperty('pendingReceipt');
});
// B1 (0250): the restored three-tool mentor call reaches bill2_claim; a fourth tool is refused before any RPC.
it.each([[3, true], [4, false]] as const)('claims a PAYG call carrying %s tool definitions: %s', async (tools, reaches) => {
  const { api, rpc } = setup(() => ({ id: callId, state: 'prepared', dispatchToken: randomUUID() }));
  const frozen = frozenCall('{}');
  const claim = api.claimPaygCall(runId, 1, { ...frozen, payg: { ...frozen.payg!, tools } });
  if (reaches) {
    expect(await claim).toEqual({ id: callId, state: 'prepared' });
    expect((rpc.mock.calls[0]![1].p_payload as { payg: { tools: number } }).payg.tools).toBe(3);
  } else {
    await expect(claim).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  }
});

// A pending refusal is not a host no_delivery verdict, regardless of the immediate lookup outcome.
it.each(['timeout', 'nonzero'])('keeps a 403 pending refusal unconfirmed after lookup %s', async outcome => {
  const frozen = {...frozenCall('{}'), provider: 'openrouter', protocol: 'openrouter-chat-v1' as const};
  const generationId = 'gen-synthetic';
  const observed = (rawBody: string, httpStatus: number) => ({rawBody, httpStatus, complete: true,
    rawBodyBase64: Buffer.from(rawBody).toString('base64'), transportIssue: null,
    sourceHash: createHash('sha256').update(rawBody).digest('hex')});
  const {api, rpc, adapter} = setup(name => {
    if (name === 'bill2_dispatch') return {dispatch: true};
    if (name === 'bill2_pending_calls') return [callId];
    if (name === 'bill2_recovery_claim') return {...frozen, providerId: generationId, rejectionRecovery: {}};
    if (name === 'bill2_record' || name === 'bill2_read') return {id: runId, state: 'cost_pending'};
    return {id: callId, state: 'prepared', dispatchToken: randomUUID()};
  });
  adapter.prepareDispatch.mockResolvedValue(async () => ({...observed(
    JSON.stringify({error: {code: 403, message: 'refused'}}), 403), generationId}));
  if (outcome === 'timeout') adapter.lookup.mockRejectedValue(new Error('timeout'));
  else adapter.lookup.mockResolvedValue(observed(JSON.stringify({data: {id: generationId, model: frozen.model,
    finish_reason: 'stop', total_cost: 0.001, native_tokens_prompt: 1, native_tokens_completion: 1}}), 200));
  await api.claimPaygCall(runId, 1, frozen);
  expect(await api.dispatchOnce(callId, '{}')).toMatchObject({
    dispatched: true, providerRejected: true, providerRejectionPending: true,
  });
  expect(adapter.lookup).toHaveBeenCalledOnce();
  const evidence = rpc.mock.calls.filter(([name]) => name === 'bill2_record').map(([,args]) => args.p_evidence);
  expect(evidence[0]).toMatchObject({evidenceKind: 'provider_rejection_pending'});
  expect(evidence[1]).toMatchObject(outcome === 'timeout' ? {cost: null} : {cost: '0.001'});
});
