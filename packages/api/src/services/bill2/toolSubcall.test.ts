/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { BillingClaimRejection } from './claimFailure';
import type { BillingRpc } from './service';
import type { ToolClaimPayload, toolResultEvidence } from './toolBilling';
import { toolSubcallBilling } from './toolSubcall';

const actorId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const callId = '33333333-3333-4333-8333-333333333333';
const token = '44444444-4444-4444-8444-444444444444';
const payload: ToolClaimPayload = {
  provider: 'parallel', account: 'parallel-main', model: 'parallel:parallel:search:fast',
  protocol: 'research-tool-v1', phase: 'question', requestHash: 'a'.repeat(64), automaticRetry: false,
  hiddenTools: false, lookupSupported: false, upperUsd: '0.001', billingUnit: { modelId: callId, multiplier: '6' },
  toolPricing: { unit: 'sku_search', currency: 'USD', price: '0.001', unitsPerPrice: '1',
    usdPerCurrency: null, entryHash: 'b'.repeat(64), validUntil: '2026-12-01T00:00:00Z', maxUnitsPerCall: '1' },
};
const evidence: ReturnType<typeof toolResultEvidence> = {
  provider: 'parallel', account: payload.account, model: payload.model, protocol: 'research-tool-v1',
  providerId: callId, source: 'response', sourceHash: 'c'.repeat(64), observedAt: '2026-10-15T00:00:00Z',
  coverage: 'request_total', final: true, currency: 'USD', cost: '0.001',
  usage: { unit: 'sku_search', units: '1' }, evidenceKind: 'tool_result', toolOutcome: 'delivered',
};
function fixture() {
  const rpc = vi.fn<BillingRpc['rpc']>();
  const billing = toolSubcallBilling({ admin: { rpc }, actorId, runId });
  return { rpc, billing };
}

describe('actor-bound tool subcall billing RPCs', () => {
  it('binds all RPCs to the trusted actor and run and forwards frozen claim data', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValueOnce({ data: { id: callId, state: 'claimed', dispatchToken: token }, error: null });
    expect(await billing.claim(2, payload)).toEqual({ state: 'claimed', callId, token });
    expect(rpc).toHaveBeenLastCalledWith('bill2_claim', {
      p_run_id: runId, p_actor_id: actorId, p_sequence: 2, p_payload: payload,
    });
    rpc.mockResolvedValueOnce({ data: { dispatch: true }, error: null });
    expect(await billing.dispatch(callId, token)).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith('bill2_dispatch', {
      p_run_id: runId, p_actor_id: actorId, p_call_id: callId, p_token: token,
    });
    rpc.mockResolvedValueOnce({ data: {}, error: null });
    expect(await billing.record(callId, evidence)).toEqual({ accountClosed: false, contentDeleted: false });
    expect(rpc).toHaveBeenLastCalledWith('bill2_record', {
      p_run_id: runId, p_actor_id: actorId, p_call_id: callId, p_evidence: evidence,
    });
  });

  it('accepts waiting credits without a call id and treats missing dispatch tokens as replay', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValueOnce({ data: { state: 'waiting_credits', id: null }, error: null });
    expect(await billing.claim(1, payload)).toEqual({ state: 'waiting_credits' });
    for (const raw of [{ id: callId, state: 'claimed' }, { id: callId, state: 'done', dispatchToken: null }]) {
      rpc.mockResolvedValueOnce({ data: raw, error: null });
      expect(await billing.claim(1, payload)).toEqual({ state: 'replayed', callId });
    }
  });

  it('does not grant permission to send on dispatch false', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: { dispatch: false }, error: null });
    expect(await billing.dispatch(callId, token)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed identifiers and sequence locally', async () => {
    const { rpc, billing } = fixture();
    expect(() => toolSubcallBilling({ admin: { rpc }, actorId: 'untrusted', runId })).toThrow();
    expect(() => toolSubcallBilling({ admin: { rpc }, actorId, runId: 'invalid' })).toThrow();
    for (const sequence of [0, -1, 1.5, NaN]) await expect(billing.claim(sequence, payload)).rejects.toThrow();
    await expect(billing.dispatch('invalid', token)).rejects.toThrow();
    await expect(billing.dispatch(callId, 'invalid')).rejects.toThrow();
    await expect(billing.record('invalid', evidence)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['claim', 'dispatch'] as const)('preserves known %s rejection codes without retry', async action => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: 'BILL2_TOOL_PRICE_EXPIRED' } });
    const promise = action === 'claim' ? billing.claim(1, payload) : billing.dispatch(callId, token);
    await expect(promise).rejects.toBeInstanceOf(BillingClaimRejection);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('redacts unknown database errors and never retries a claim', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: 'private database detail' } });
    await expect(billing.claim(1, payload)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['database', 'transport'] as const)('retries a %s record failure once with identical evidence', async failure => {
    const { rpc, billing } = fixture();
    if (failure === 'database') rpc.mockResolvedValueOnce({ data: null, error: { message: 'failure' } });
    else rpc.mockRejectedValueOnce(new Error('timeout after possible commit'));
    rpc.mockResolvedValueOnce({ data: { accountClosed: true }, error: null });
    expect(await billing.record(callId, evidence)).toEqual({ accountClosed: true, contentDeleted: false });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls.every(([name]) => name === 'bill2_record')).toBe(true);
  });

  it('stops after two failed record attempts instead of pretending the cost was saved', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: 'private database detail' } });
    await expect(billing.record(callId, evidence)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('retains account and content deletion signals after a successful record', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: { accountClosed: true, contentDeleted: true }, error: null });
    expect(await billing.record(callId, evidence)).toEqual({ accountClosed: true, contentDeleted: true });
  });

  it('fails closed for malformed claim, dispatch and receipt responses', async () => {
    const { rpc, billing } = fixture();
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(billing.claim(1, payload)).rejects.toThrow();
    await expect(billing.dispatch(callId, token)).rejects.toThrow();
    await expect(billing.record(callId, evidence)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
