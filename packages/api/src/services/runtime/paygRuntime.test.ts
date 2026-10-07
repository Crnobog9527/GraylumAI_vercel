/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { runtimePaygCall } from './paygRuntime';
import type { FrozenPaygRun } from '../bill2/service';
import { openRouterBound } from '../bill2/openRouterPolicy';
const modelId = '10000000-0000-4000-8000-000000000001';
const pricingHash = 'a'.repeat(64);
const limits = { providerSlug: 'local', contextTokens: 300000, promptUsdPerMillion: '1.25',
  cacheWriteUsdPerMillion: '1.25', completionUsdPerMillion: '2', requestUsd: '0' };
const policy: FrozenPaygRun['callPolicy'][number] = { modelId, model: 'model', provider: 'fixture',
  account: 'local', protocol: 'fixture-cost-v1', inputLimit: 196608, outputLimit: 1000,
  upperUsd: openRouterBound(limits, 1000).upperUsd, providerLimits: limits, multiplier: '3',
  automaticRetry: false, hiddenTools: false, lookupSupported: true,
  payg: { policyId: 'fixture', version: '1', profileVersion: '1', evidenceVersion: '1', pricingHash,
    endpointTag: 'local', templateTokens: 4096, marginTokens: 4096, admissionPath: 'fixture',
    maxBytes: 196608, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384, purposes: ['ordinary'],
    expiresAt: '2099-01-01T00:00:00Z', nominalPricing: { version: 'nominal-v1', pricingHash,
      endpointTag: 'local', tiers: [{ minPromptTokens: 0, prompt: '1', completion: '2', request: '0' }], timeOfDay: [] } } };
const rules: FrozenPaygRun['rules'] = { version: '1', quoteVersion: '1', creditsPerUsd: '100', multiplier: '3', fx: {},
  billingUnit: { version: 'bill-unit-v2', creditsPerUsd: '100', defaultMultiplier: '3', providers: {}, hash: 'b'.repeat(64),
    models: { [modelId]: { multiplier: '3', source: 'global' } } } };
it('binds UTF-8 final bytes, tools, routing quote, multiplier and epoch without float money', () => {
  const body = JSON.stringify({ model: 'model', messages: [{ role: 'user', content: '你好😀\\"' }],
    tools: [{ function: { name: 'read', parameters: { type: 'object', properties: {} } } }] });
  const { call, upperCredits } = runtimePaygCall(body, 'ordinary', policy, rules, 7);
  const bytes = Buffer.byteLength(body), t = bytes + 8192;
  expect(call.payg).toMatchObject({ bytes, promptTokensUpper: t, messages: 1, tools: 1,
    schemaBytes: Buffer.byteLength(JSON.stringify({ type: 'object', properties: {} })) });
  expect(call.runtimeEpoch).toBe(7);
  const u = (BigInt(t) * 1250000000000n + 1000n * 2000000000000n + 999999n) / 1000000n;
  expect(call.upperUsd).toBe(`${u / 1000000000000n}.${String(u % 1000000000000n).padStart(12, '0')}`);
  expect(upperCredits).toBe(Number((u * 300n + 999999999999n) / 1000000000000n));
  expect(call.payg?.bytes).toBeGreaterThan(body.length);
});
it('rejects unsupported purpose, oversized messages, missing policy and mismatched nominal prices', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }] });
  expect(() => runtimePaygCall(body, 'unapproved', policy, rules, 1)).toThrow('BILL2_PAYG_QUOTE_INVALID');
  expect(() => runtimePaygCall(JSON.stringify({ messages: Array(33).fill({ content: 'x' }) }), 'ordinary', policy, rules, 1))
    .toThrow('BILL2_INPUT_PROFILE_INVALID');
  expect(() => runtimePaygCall(body, 'ordinary', { ...policy, payg: undefined }, rules, 1)).toThrow();
  const bad = structuredClone(policy); bad.payg!.nominalPricing.tiers[0]!.prompt = '100';
  expect(() => runtimePaygCall(body, 'ordinary', bad, rules, 1)).toThrow('BILL2_NOMINAL_BOUND_CONFLICT');
});

it.each([8192,32768])('reserves exact request-based money for frozen O=%i without changing input capacity', outputLimit => {
 const frozen={...policy,outputLimit,upperUsd:openRouterBound(limits,outputLimit).upperUsd};
 const body=JSON.stringify({model:'model',max_tokens:outputLimit,messages:[{role:'user',content:'Synthetic cap test'}]});
 const {call,upperCredits}=runtimePaygCall(body,'ordinary',frozen,rules,1,true);
 const t=Buffer.byteLength(body)+8192;
 const u=(BigInt(t)*1250000000000n+BigInt(outputLimit)*2000000000000n+999999n)/1000000n;
 expect(call.upperUsd).toBe(`${u/1000000000000n}.${String(u%1000000000000n).padStart(12,'0')}`);
 expect(upperCredits).toBe(Number((u*300n+999999999999n)/1000000000000n));
 expect(call.inputLimit).toBe(196608);expect(call.outputLimit).toBe(outputLimit);
 const tooLarge=JSON.stringify({...JSON.parse(body),max_tokens:outputLimit+1});
 expect(()=>runtimePaygCall(tooLarge,'ordinary',frozen,rules,1,true)).toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
});
