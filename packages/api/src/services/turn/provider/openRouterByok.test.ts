/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { decisionsCostUsd, resolveOpenRouterCost, withByok } from './openRouterByok';
import { openRouterEvidence } from './openRouterEvidence';

// BILL-BYOK: OpenRouter's cost under BYOK is only its fee; the vendor's charge is upstream_inference_cost.
const identity = { provider: 'openrouter', account: 'test-account', model: 'test/model', protocol: 'openrouter-chat-v1' } as const;
const observed = (raw: string, status = 200) => ({ rawBody: raw, rawBodyBase64: Buffer.from(raw).toString('base64'), sourceHash: 'unused',
  httpStatus: status, complete: true, transportIssue: null });
const response = (usage: Record<string, unknown>) => observed(JSON.stringify({ id: 'gen-1', model: 'test/model',
  choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
  usage: { prompt_tokens: 2000, completion_tokens: 600, ...usage } }));
const lookup = (data: Record<string, unknown>) => observed(JSON.stringify({ data: { id: 'gen-1', model: 'test/model-20261101',
  finish_reason: 'stop', native_tokens_prompt: 2000, native_tokens_completion: 600, ...data } }));
const exact = (value: unknown) => { if (typeof value !== 'string' || !/^\d+(\.\d{1,12})?$/.test(value)) throw new Error('x'); return value; };

describe('resolveOpenRouterCost', () => {
  it('a BYOK call costs the fee plus the upstream charge, exactly, with the split kept', () => {
    expect(resolveOpenRouterCost({ cost: '0.0005', isByok: true, upstream: '0.01' }, exact))
      .toEqual({ kind: 'final', cost: '0.0105', byok: { feeUsd: '0.0005', upstreamUsd: '0.01' } });
    // The fee is waived within OpenRouter's monthly allowance: the cost is the upstream charge alone.
    expect(resolveOpenRouterCost({ cost: '0', isByok: true, upstream: '0.000000000001' }, exact))
      .toEqual({ kind: 'final', cost: '0.000000000001', byok: { feeUsd: '0', upstreamUsd: '0.000000000001' } });
  });
  it.each([false, undefined, null])('is_byok %s keeps the reported cost and never adds the upstream field', isByok => {
    expect(resolveOpenRouterCost({ cost: '0.01', isByok, upstream: '0.01' }, exact)).toEqual({ kind: 'final', cost: '0.01' });
  });
  it.each([undefined, null, 1])('BYOK without a usable upstream amount (%s) is missing cost, never the fee alone', upstream => {
    expect(resolveOpenRouterCost({ cost: '0.0005', isByok: true, upstream }, exact)).toEqual({ kind: 'missing' });
  });
  it('a malformed is_byok or amount is invalid evidence', () => {
    expect(resolveOpenRouterCost({ cost: '0.01', isByok: 'true', upstream: '0.01' }, exact)).toEqual({ kind: 'invalid' });
    expect(resolveOpenRouterCost({ cost: '0.0005', isByok: true, upstream: '0.0000000000001' }, exact)).toEqual({ kind: 'invalid' });
    expect(resolveOpenRouterCost({ cost: '-1', isByok: true, upstream: '0.01' }, exact)).toEqual({ kind: 'invalid' });
  });
  it('withByok only adds the split for a BYOK call', () => {
    expect(withByok({ inputTokens: '1' }, undefined)).toEqual({ inputTokens: '1' });
    expect(withByok({ inputTokens: '1' }, { feeUsd: '0', upstreamUsd: '1' })).toEqual({ inputTokens: '1', byok: { feeUsd: '0', upstreamUsd: '1' } });
  });
});

describe('openRouterEvidence under BYOK', () => {
  it('a response receipt: cost = fee + upstream, final, with the split; tokens unchanged', () => {
    const evidence = openRouterEvidence(response({ cost: 0.0005, is_byok: true,
      cost_details: { upstream_inference_cost: 0.01, upstream_inference_prompt_cost: 0.004, upstream_inference_completions_cost: 0.006 } }),
    identity, 'response');
    expect(evidence).toMatchObject({ cost: '0.0105', final: true, byok: { feeUsd: '0.0005', upstreamUsd: '0.01' },
      usage: { inputTokens: '2000', outputTokens: '600' } });
  });
  it('a non-BYOK response (and a BYOK key OpenRouter fell back from) is exactly as before, though upstream is reported', () => {
    for (const isByok of [false, undefined]) {
      const evidence = openRouterEvidence(response({ cost: 0.0102, ...(isByok === undefined ? {} : { is_byok: isByok }),
        cost_details: { upstream_inference_cost: 0.0102 } }), identity, 'response');
      expect(evidence).toMatchObject({ cost: '0.0102', final: true });
      expect(evidence).not.toHaveProperty('byok');
    }
  });
  it('a BYOK response without the upstream cost is not final (the lookup and the unknown-cost rules take over)', () => {
    for (const details of [{}, { cost_details: null }, { cost_details: { upstream_inference_cost: null } }]) {
      expect(openRouterEvidence(response({ cost: 0.0005, is_byok: true, ...details }), identity, 'response'))
        .toMatchObject({ cost: null, final: false, costIssue: 'missing_cost' });
    }
  });
  it('the generation lookup: total_cost + upstream_inference_cost for BYOK, total_cost alone otherwise', () => {
    expect(openRouterEvidence(lookup({ total_cost: 0.0005, is_byok: true, upstream_inference_cost: 0.01 }), identity, 'lookup', 'gen-1'))
      .toMatchObject({ cost: '0.0105', final: true, byok: { feeUsd: '0.0005', upstreamUsd: '0.01' } });
    // The non-BYOK lookup reports upstream_inference_cost 0 (staging probe 2026-10-12): never added, never a reason to doubt.
    const plain = openRouterEvidence(lookup({ total_cost: 0.0102, is_byok: false, upstream_inference_cost: 0 }), identity, 'lookup', 'gen-1');
    expect(plain).toMatchObject({ cost: '0.0102', final: true });
    expect(plain).not.toHaveProperty('byok');
    expect(openRouterEvidence(lookup({ total_cost: 0.0005, is_byok: true }), identity, 'lookup', 'gen-1'))
      .toMatchObject({ cost: null, final: false });
  });
});

describe('decisionsCostUsd (positioning check, platform-paid)', () => {
  it('fee + upstream under BYOK; the reported cost otherwise; unknown when BYOK lacks the upstream amount', () => {
    expect(decisionsCostUsd({ cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } })).toBeCloseTo(0.0021, 12);
    expect(decisionsCostUsd({ cost: 0.002, is_byok: false, cost_details: { upstream_inference_cost: 0.002 } })).toBe(0.002);
    expect(decisionsCostUsd({ cost: 0.002 })).toBe(0.002);
    expect(decisionsCostUsd({ cost: 0.0001, is_byok: true })).toBeNull();
    expect(decisionsCostUsd({ cost: 0.0001, is_byok: 'yes' })).toBeNull();
    expect(decisionsCostUsd({})).toBeNull();
    expect(decisionsCostUsd(undefined)).toBeNull();
  });
});
