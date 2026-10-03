/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { paygCallQuote, paygStablePolicy } from './paygPolicy';
import { measureCallInput, openRouterBound, openRouterCallBound } from './openRouterPolicy';
const identity = { policyId: 'policy', profileVersion: 'v1', evidenceVersion: 'fixture-v1',
  pricingHash: 'a'.repeat(64), endpointTag: 'provider/exact', templateTokens: 4096, marginTokens: 4096,
  nominalPricing: { version: 'nominal-v1', pricingHash: 'a'.repeat(64), endpointTag: 'provider/exact',
    tiers: [{ minPromptTokens: 0, prompt: '2', completion: '10', request: '0' }], timeOfDay: [] } };
const quote = { ...identity, policyVersion: 'v1', bytes: 100, promptTokensUpper: 8292, messages: 1, tools: 0, schemaBytes: 0 };
it('strict stable/call contracts bind identity, exact T and profile bounds', () => {
  expect(paygCallQuote.safeParse(quote).success).toBe(true);
  expect(paygCallQuote.safeParse({ ...quote, promptTokensUpper: 8293 }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...quote, endpointTag: 'other' }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...quote, tools: 3 }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...quote, extra: true }).success).toBe(false);
  expect(paygStablePolicy.safeParse({ ...identity, version: 'v1', admissionPath: 'fixture',
    maxBytes: 196608, maxMessages: 32, maxTools: 2, maxSchemaBytes: 16384,
    purposes: ['mentor'], expiresAt: '2026-10-04T00:00:00Z' }).success).toBe(true);
});
it('measures final UTF-8 bytes and includes cache-block bytes once', () => {
  const serialized = JSON.stringify({ text: '中文🙂', cache: 'x'.repeat(88) });
  const measured = measureCallInput(serialized, 4096, 4096);
  expect(measured.requestBytes).toBe(Buffer.byteLength(serialized));
  expect(measured.promptTokensUpper).toBe(Buffer.byteLength(serialized) + 8192);
  expect(() => measureCallInput(serialized, -1, 0)).toThrow();
});
it('per-call bound uses max cache-write price and rounds once at 12 decimals', () => {
  const limits = { providerSlug: 'provider/exact', contextTokens: 100000,
    promptUsdPerMillion: '2', cacheWriteUsdPerMillion: '2.5', completionUsdPerMillion: '10', requestUsd: '0' };
  expect(openRouterCallBound(limits, 8192, 48192).upperUsd).toBe('0.202400000000');
  expect(openRouterCallBound(limits, 8192, 48192).routing).toEqual(openRouterBound(limits, 8192).routing);
  expect(() => openRouterCallBound(limits, 8192, 100000)).toThrow('CAPACITY');
  expect(openRouterCallBound({ ...limits, promptUsdPerMillion: '0.0000011',
    cacheWriteUsdPerMillion: '0', completionUsdPerMillion: '0' }, 1, 1).upperUsd).toBe('0.000000000002');
});
