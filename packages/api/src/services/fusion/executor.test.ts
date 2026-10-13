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
  it('passes the call rate limit for every call of the batch before any hold', async () => {
    const h = harness();
    await h.executor.claim('group', 'review:1', 1, [run, { ...run, runId: 'run-2' }]);
    expect(h.gate).toHaveBeenCalledWith('actor', 2, 'bill2.v2');
    h.gate.mockResolvedValueOnce({ ok: false, reason: 'call_limited', retryAfter: 30, window: 'minute' } as never);
    await expect(h.executor.claim('group', 'review:2', 1, [run])).rejects.toThrow();
    expect(h.billing.claimFusionGroup).toHaveBeenCalledTimes(1);
  });
  it('saves the body, writes the host verdict, then settles and closes the run', async () => {
    const h = harness(); const onChunk = vi.fn();
    const result = await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable', onChunk);
    expect(result).toEqual({ state: 'judged', verdict: 'usable', text: '{"issues":[]}' });
    expect(h.calls).toEqual(['dispatch', 'fusion_call_output_save:', 'fusion_call_verdict:usable', 'finalize', 'cancel', 'finalize']);
    expect(h.billing.dispatchOnce).toHaveBeenCalledWith('call-1', run.body, onChunk);
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
    expect(h.calls).not.toContain('fusion_call_output_save:');
  });
  it('leaves unreadable or unconfirmed responses to recovery, with no saved body and no verdict', async () => {
    for (const [dispatch, reason] of [
      [{ dispatched: true, observation: observation(sse('x'), false) }, 'response_unreadable'],
      [{ dispatched: false, transportNotStarted: true }, 'not_started'],
      [{ dispatched: false }, 'not_dispatched'],
      [{ dispatched: true, contentDeleted: true }, 'closed'],
    ] as const) {
      const h = harness(dispatch);
      expect(await h.executor.run(run, { runId: 'run-1', id: 'call-1', state: 'prepared', fresh: true }, () => 'usable'))
        .toEqual({ state: 'pending', reason });
      expect(h.admin.rpc).not.toHaveBeenCalled();
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
