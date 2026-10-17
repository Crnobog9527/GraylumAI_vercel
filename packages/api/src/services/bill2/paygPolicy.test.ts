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
  // B1 (0250): three tools per call, never four.
  // RT-3b PR-2 (0267): up to nine tools per call (card, Skill file, history, six research tools), never ten.
  expect(paygCallQuote.safeParse({ ...quote, tools: 9 }).success).toBe(true);
  expect(paygCallQuote.safeParse({ ...quote, tools: 10 }).success).toBe(false);
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

it('accepts 128-message per-call evidence and rejects 129 without weakening T',()=>{
 expect(paygCallQuote.safeParse({...quote,messages:128}).success).toBe(true);
 expect(paygCallQuote.safeParse({...quote,messages:129}).success).toBe(false);
 expect(paygCallQuote.safeParse({...quote,messages:128,promptTokensUpper:100}).success).toBe(false);
});

it('LIB-2d: an image quote counts text bytes plus the image token ceiling, never the base64 length', () => {
  const image = { dataUrlBytes: 800_000, width: 1600, height: 1131, tokensUpper: 2 * 115 * 81 + 2048 };
  const withImage = { ...quote, bytes: 100 + image.dataUrlBytes, promptTokensUpper: 100 + image.tokensUpper + 8192, image };
  expect(paygCallQuote.safeParse(withImage).success).toBe(true);
  expect(paygCallQuote.safeParse({ ...withImage, promptTokensUpper: withImage.bytes + 8192 }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...withImage, image: { ...image, tokensUpper: image.tokensUpper - 1 } }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...withImage, bytes: image.dataUrlBytes, promptTokensUpper: image.tokensUpper + 8192 })
    .success).toBe(false); // no text part
  expect(paygCallQuote.safeParse({ ...withImage, bytes: 196_609 + image.dataUrlBytes,
    promptTokensUpper: 196_609 + image.tokensUpper + 8192 }).success).toBe(false); // text above the PAYG cap
  expect(paygCallQuote.safeParse({ ...quote, bytes: 196_609, promptTokensUpper: 196_609 + 8192 }).success).toBe(false);
  expect(paygCallQuote.safeParse({ ...withImage, image: { ...image, extra: 1 } }).success).toBe(false);
  const stable = { ...identity, version: 'v1', admissionPath: 'fixture', maxBytes: 196608, maxMessages: 32, maxTools: 2,
    maxSchemaBytes: 16384, purposes: ['library_ocr'], expiresAt: '2026-10-04T00:00:00Z' };
  expect(paygStablePolicy.safeParse({ ...stable, imageInput: { maxDataUrlBytes: 819_223, maxEdge: 1600 } }).success).toBe(true);
  expect(paygStablePolicy.safeParse({ ...stable, imageInput: { maxDataUrlBytes: 819_224, maxEdge: 1600 } }).success).toBe(false);
  expect(paygStablePolicy.safeParse({ ...stable, imageInput: { maxDataUrlBytes: 1, maxEdge: 2049 } }).success).toBe(false);
});
it('LIB-2d: the image price is bounded once per image token and caps max_price.image only when declared', () => {
  const limits = { providerSlug: 'provider/exact', contextTokens: 100000,
    promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0', imageUsd: '0.000001' };
  const tokens = 2 * 115 * 81 + 2048, t = 100 + tokens + 8192;
  // (3·T + 15·4096)/1e6 rounded up at 12 places, plus 0.000001 × image tokens.
  const text = (3n * BigInt(t) * 1_000_000_000_000n + 15n * 4096n * 1_000_000_000_000n + 999_999n) / 1_000_000n;
  const total = text + 1_000_000n * BigInt(tokens);
  expect(openRouterCallBound(limits, 4096, t, tokens).upperUsd)
    .toBe(`${total / 1_000_000_000_000n}.${String(total % 1_000_000_000_000n).padStart(12, '0')}`);
  expect(openRouterCallBound(limits, 4096, t, tokens).routing.max_price).toEqual({ prompt: 3, completion: 15, request: 0, image: 0.000001 });
  const textOnly: Partial<typeof limits> & Omit<typeof limits, 'imageUsd'> = { ...limits };
  delete textOnly.imageUsd;
  expect(openRouterCallBound(textOnly, 4096, t).routing.max_price).toEqual({ prompt: 3, completion: 15, request: 0 });
  expect(() => openRouterCallBound(textOnly, 4096, t, tokens)).toThrow('BILL2_IMAGE_PRICE_REQUIRED');
  expect(() => openRouterCallBound(limits, 4096, 10, tokens)).toThrow('BILL2_IMAGE_PRICE_REQUIRED');
  expect(openRouterCallBound({ ...limits, imageUsd: '0' }, 4096, t, tokens).upperUsd)
    .toBe(openRouterCallBound(textOnly, 4096, t).upperUsd);
});
