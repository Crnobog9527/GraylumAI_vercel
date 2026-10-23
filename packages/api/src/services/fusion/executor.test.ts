/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TransportObservation } from '../bill2/fixtureAdapter';
import type { RuntimeBudget } from '../runtime/budget';
import { fusionExecutor, fusionResponseText } from './executor';
import type { AdmittedFusionRun } from './admission';

const model = 'anthropic/claude-sonnet-5.5';
const sse = (content: string) => [
  `data: ${JSON.stringify({ id: 'gen-1', model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'gen-1', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  'data: [DONE]\n\n'].join('');
function observation(text: string, complete = true): TransportObservation {
  const bytes = Buffer.from(text), hash = createHash('sha256').update(bytes).digest('hex');
  return { rawBody: '', rawBodyBase64: gzipSync(bytes).toString('base64'), rawBodyEncoding: 'gzip-base64', rawBodyByteLength: bytes.length,
    rawBodySha256: hash, observedByteLength: bytes.length, sourceHash: hash, stream: true, httpStatus: 200, complete, transportIssue: null };
}
const run = { runId: 'run-1', index: 0, phase: 'fusion_review', body: '{"x":1}', call: { model } } as unknown as AdmittedFusionRun;
function harness(dispatch: Record<string, unknown> = { dispatched: true, observation: observation(sse('{"issues":[]}')) }) {
  const calls: string[] = [];
  const billing = {
    claimFusionGroup: vi.fn(async () => { calls.push('claim'); return { state: 'claimed', calls: [] }; }),
    rotatePrepared: vi.fn(async () => { calls.push('rotate'); return true; }),
    dispatchOnce: vi.fn(async () => { calls.push('dispatch'); return dispatch; }),
    recordReceipt: vi.fn(async () => ({})),
    finalizeRun: vi.fn(async () => { calls.push('finalize'); return { state: 'settled', closed: true }; }),
    requestCancel: vi.fn(async () => { calls.push('cancel'); return {}; }),
  };
  const admin = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push(`${name}:${String(args.p_verdict ?? '')}`); return { data: {}, error: null }; }) };
  const gate = vi.fn(async () => ({ ok: true as const }));
  const budget = { modelCallTimeout: vi.fn(() => 240_000) } as unknown as RuntimeBudget;
  const executor = fusionExecutor({ billing: billing as never, admin: admin as unknown as SupabaseClient, actorId: 'actor', callGate: gate, budget });
  return { executor, billing, admin, gate, budget, calls };
}

describe('Fusion executor', () => {
  it('takes exactly one call-gate unit per actual dispatch; claiming takes none; a refusal releases that hold', async () => {
    const h = harness();
    await h.executor.claim('group', 'review:1', 1, [run, { ...run, runId: 'run-2' }]);
    expect(h.gate).not.toHaveBeenCalled();
    // One browser request per model: the first owns a fresh token, the others rotate; each counts once.
    await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable');
    await h.executor.run({ ...run, runId: 'run-2' }, { runId: 'run-2', id: 'call-2', state: 'prepared', fresh: false }, () => 'usable');
    expect(h.gate).toHaveBeenCalledTimes(2);
    expect(h.gate).toHaveBeenNthCalledWith(1, 'actor', 1, 'bill2.v2');
    expect(h.gate).toHaveBeenNthCalledWith(2, 'actor', 1, 'bill2.v2');
    h.gate.mockResolvedValueOnce({ ok: false, reason: 'call_limited', retryAfter: 30, window: 'minute' } as never);
    h.calls.length = 0;
    await expect(h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: false }, () => 'usable')).rejects.toThrow();
    // The request that owns the dispatch (it rotated the token) is the one whose refusal releases the hold.
    expect(h.calls).toEqual(['rotate', 'finalize', 'cancel', 'finalize']);
  });
  it('saves the body, writes the host verdict, then settles and closes the run', async () => {
    const h = harness(); const onChunk = vi.fn();
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable', onChunk);
    expect(result).toEqual({ state: 'judged', verdict: 'usable', text: '{"issues":[]}' });
    expect(h.calls).toEqual(['dispatch', 'fusion_call_output_save:', 'fusion_call_verdict:usable', 'finalize', 'cancel', 'finalize']);
    expect(h.billing.dispatchOnce).toHaveBeenCalledWith('call-1', run.body, onChunk);
  });
  it('a reply the host refuses before saving (positioning fallback marker) is never saved, judged no_delivery and settled free', async () => {
    const h = harness({ dispatched: true, observation: observation(sse('[[GRAYLUM_POSITIONING_REQUIRED]]')) });
    const refuse = vi.fn((text: string) => text.startsWith('[[GRAYLUM_POSITIONING_REQUIRED]]'));
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable', undefined, refuse);
    expect(result).toEqual({ state: 'judged', verdict: 'no_delivery' });
    expect(refuse).toHaveBeenCalledWith('[[GRAYLUM_POSITIONING_REQUIRED]]');
    // No fusion_call_output_save: 0235 allows no_delivery only for a call without a saved body.
    expect(h.calls).toEqual(['dispatch', 'fusion_call_verdict:no_delivery', 'finalize', 'cancel', 'finalize']);
  });
  it('a reply the host does not refuse is saved and judged as before, and `refuse` is optional', async () => {
    const h = harness();
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable', undefined, () => false);
    expect(result).toMatchObject({ state: 'judged', verdict: 'usable' });
    expect(h.calls).toContain('fusion_call_output_save:');
  });
  it('a request that loses the dispatch to another owner never touches the call gate or the shared run', async () => {
    const h = harness();
    (h.billing.rotatePrepared as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    h.gate.mockResolvedValue({ ok: false as const, reason: 'rate_limited' } as never);
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: false }, () => 'usable');
    expect(result).toEqual({ state: 'pending', reason: 'not_dispatched' });
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('finalize');
    expect(h.calls).not.toContain('cancel');
    expect(h.billing.dispatchOnce).not.toHaveBeenCalled();
  });
  it('checks the time budget before dispatch and stops without dispatching when exhausted', async () => {
    const h = harness();
    (h.budget.modelCallTimeout as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('RUNTIME_TIME_BUDGET_EXHAUSTED'); });
    await expect(h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable')).rejects.toThrow('EXHAUSTED');
    expect(h.billing.dispatchOnce).not.toHaveBeenCalled();
  });
  it('rotates a token for a replayed claim; a provider refusal is judged no_delivery', async () => {
    const h = harness({ dispatched: true, providerRejected: true, observation: observation('{}') });
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: false }, () => 'usable');
    expect(result).toEqual({ state: 'judged', verdict: 'no_delivery' });
    expect(h.calls.slice(0, 3)).toEqual(['rotate', 'dispatch', 'fusion_call_verdict:no_delivery']);
    expect(h.gate).toHaveBeenCalledWith('actor', 1, 'bill2.v2');
    expect(h.calls).not.toContain('fusion_call_output_save:');
  });
  it('leaves unreadable or unconfirmed responses to recovery, with no saved body and no verdict', async () => {
    for (const [dispatch, reason] of [
      [{ dispatched: true, observation: observation(sse('x'), false) }, 'response_unreadable'],
      [{ dispatched: true, providerRejected: true, providerRejectionPending: true,
        observation: {...observation('{}'), httpStatus: 403} }, 'receipt_pending'],
      [{ dispatched: false, transportNotStarted: true }, 'not_started'],
      [{ dispatched: false }, 'not_dispatched'],
      [{ dispatched: true, contentDeleted: true }, 'closed'],
    ] as const) {
      const h = harness(dispatch);
      expect(await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable'))
        .toEqual({ state: 'pending', reason });
      expect(h.admin.rpc).not.toHaveBeenCalled();
      expect(h.billing.finalizeRun).not.toHaveBeenCalled();
      expect(h.billing.requestCancel).not.toHaveBeenCalled();
    }
  });
  it('stop cancels and settles each run', async () => {
    const h = harness();
    await h.executor.stop(['run-1', 'run-2']);
    expect(h.calls).toEqual(['cancel', 'finalize', 'cancel', 'finalize']);
  });
  it('reads only a complete stream back as text', () => {
    expect(fusionResponseText(observation(sse('正文')), model)).toBe('正文');
    expect(fusionResponseText(observation(sse('正文'), false), model)).toBeNull();
    expect(fusionResponseText({ ...observation(sse('正文')), httpStatus: 500 }, model)).toBeNull();
    expect(fusionResponseText(undefined, model)).toBeNull();
  });
});
