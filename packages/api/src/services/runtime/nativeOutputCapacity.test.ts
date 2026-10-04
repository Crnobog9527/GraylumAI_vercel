/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {fitNativeRequestOutput, runtimePaygCall} from './paygRuntime';
import {measureCallInput, openRouterBound, openRouterCallBound} from '../bill2/openRouterPolicy';
import type {FrozenPaygRun} from '../bill2/service';

const modelId = '10000000-0000-4000-8000-000000000001';
const pricingHash = 'a'.repeat(64);
function fixture(contextTokens = 32000) {
  const limits = {providerSlug: 'synthetic', contextTokens,
    promptUsdPerMillion: '1', completionUsdPerMillion: '2', requestUsd: '0'};
  const policy: FrozenPaygRun['callPolicy'][number] = {
    modelId, model: 'synthetic/model', provider: 'openrouter', account: 'synthetic',
    protocol: 'openrouter-chat-v1', inputLimit: 32000, outputLimit: 8192,
    upperUsd: openRouterBound(limits, 8192).upperUsd, providerLimits: limits, multiplier: '1',
    automaticRetry: false, hiddenTools: false, lookupSupported: true,
    payg: {policyId: 'native', version: '1', profileVersion: '1', evidenceVersion: '1', pricingHash,
      endpointTag: 'synthetic', templateTokens: 100, marginTokens: 100, admissionPath: 'empirical',
      maxBytes: 32000, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['skill'],
      expiresAt: '2099-01-01T00:00:00Z', nominalPricing: {version: 'nominal-v1', pricingHash,
        endpointTag: 'synthetic', tiers: [{minPromptTokens: 0, prompt: '1', completion: '2', request: '0'}], timeOfDay: []}},
  };
  const rules: FrozenPaygRun['rules'] = {version: '1', quoteVersion: '1', creditsPerUsd: '100', multiplier: '1', fx: {},
    billingUnit: {version: 'bill-unit-v2', creditsPerUsd: '100', defaultMultiplier: '1', providers: {}, hash: 'b'.repeat(64),
      models: {[modelId]: {multiplier: '1', source: 'global'}}}};
  const request = (text: string, max_tokens = 8192, extra: Record<string, unknown> = {}) => JSON.stringify({
    model: policy.model, stream: true, stream_options: {include_usage: true}, store: false,
    messages: [{role: 'user', content: text}], max_tokens, ...extra,
  });
  return {policy, rules, request};
}

it('reduces new PAYG O to the largest value fitting final serialized T, before claim', () => {
  const {policy, rules, request} = fixture();
  const original = request('x'.repeat(27000));
  const frozen = JSON.stringify(policy);
  const fitted = fitNativeRequestOutput(original, policy);
  const parsed = JSON.parse(fitted);
  const t = measureCallInput(fitted, 100, 100).promptTokensUpper;
  expect(parsed.max_tokens).toBeLessThan(8192);
  expect(t + parsed.max_tokens).toBe(32000);
  expect({...parsed, max_tokens: 8192}).toEqual(JSON.parse(original));
  const {call} = runtimePaygCall(fitted, 'skill', policy, rules, 2, true);
  expect(call.outputLimit).toBe(parsed.max_tokens);
  expect(call.payg?.promptTokensUpper).toBe(t);
  expect(call.upperUsd).toBe(openRouterCallBound(policy.providerLimits!, parsed.max_tokens, t).upperUsd);
  expect(call.requestHash).toBe(createHash('sha256').update(fitted).digest('hex'));
  expect(JSON.stringify(policy)).toBe(frozen);
  expect(fitNativeRequestOutput(fitted, policy)).toBe(fitted);
});

it('uses actual native model output bound instead of rejecting on larger quote O', () => {
  const {policy, rules, request} = fixture();
  const original = request('x'.repeat(27000), 4096);
  expect(fitNativeRequestOutput(original, policy)).toBe(original);
  expect(runtimePaygCall(original, 'skill', policy, rules, 1, true).call.outputLimit).toBe(4096);
  expect(() => runtimePaygCall(original, 'skill', policy, rules, 1)).toThrow('BILL2_PROVIDER_CAPACITY');
});

it('preserves legacy request bytes and quote arithmetic when no native marker is passed', () => {
  const {policy, rules, request} = fixture();
  const original = request('hello', 4096);
  const legacy = runtimePaygCall(original, 'skill', policy, rules, 1);
  expect(legacy.call.outputLimit).toBe(8192);
  expect(legacy.call.upperUsd).toBe(openRouterCallBound(policy.providerLimits!, 8192,
    measureCallInput(original, 100, 100).promptTokensUpper).upperUsd);
  expect(fitNativeRequestOutput(original, policy)).toBe(original);
  const formatted = ' ' + original + '\n';
  expect(fitNativeRequestOutput(formatted, policy)).toBe(formatted);
  expect(fitNativeRequestOutput(formatted, {...policy, payg: undefined})).toBe(formatted);
});

it('rejects before claim when even one output token or frozen reasoning reserve cannot fit', () => {
  const {policy, request} = fixture();
  expect(() => fitNativeRequestOutput(request('x'.repeat(32000)), policy))
    .toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
  expect(() => fitNativeRequestOutput(request('x'.repeat(30000), 8192, {reasoning: {max_tokens: 2048}}), policy))
    .toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
  const fitted = JSON.parse(fitNativeRequestOutput(request('x'.repeat(27000), 8192, {reasoning: {max_tokens: 2048}}), policy));
  expect(fitted.max_tokens).toBeGreaterThanOrEqual(2048 + 1024);
  expect(fitted.reasoning).toEqual({max_tokens: 2048});
});

it('binds Unicode byte counts and rejects ambiguous or excessive output fields', () => {
  const {policy, rules, request} = fixture();
  const body = fitNativeRequestOutput(request('中'.repeat(9000)), policy);
  const result = runtimePaygCall(body, 'skill', policy, rules, 1, true);
  expect(result.call.payg?.bytes).toBe(Buffer.byteLength(body));
  expect(result.call.payg!.promptTokensUpper + result.call.outputLimit).toBeLessThanOrEqual(32000);
  for (const input of [request('hello', 8193), request('hello', 0), request('hello', 1, {max_completion_tokens: 2})]) {
    expect(() => fitNativeRequestOutput(input, policy)).toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
    expect(() => runtimePaygCall(input, 'skill', policy, rules, 1, true)).toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
  }
});
