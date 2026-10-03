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
