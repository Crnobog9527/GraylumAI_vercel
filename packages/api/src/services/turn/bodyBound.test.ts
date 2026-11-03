/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { bodyBoundCall } from './bodyBound';
import { TurnStop } from './call';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound, openRouterCallBound } from './provider/openRouterPolicy';
import type { ChatQuote } from './quote';
import { imageTokensUpper, JPEG_DATA_URL_PREFIX } from './provider/imageInput';
import { syntheticJpeg } from '../__tests__/fixtures/syntheticJpeg';

// A Sonnet-class route: a 1M-token context at 3 / 15 USD per million, a 32768-token output limit, the profile's 4096 + 4096 tokens.
const limits = { providerSlug: 'synthetic', contextTokens: 1_000_000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' };
const nominalPricing = { version: 'nominal-v1' as const, pricingHash: 'a'.repeat(64), endpointTag: 'synthetic',
  tiers: [{ minPromptTokens: 0, prompt: '3', completion: '15', request: '0' }], timeOfDay: [] };
const OUT = 2000, TEMPLATE = 4096, MARGIN = 4096;
const frozen = (promptBytes: number) => openRouterCallBound(limits, OUT, promptBytes + TEMPLATE + MARGIN).upperUsd;
const quote = (promptBytes: number) => ({ modelId: 'm', model: 'test/model', q: '100', multiplier: '6', upperUsd: frozen(promptBytes), pricing: nominalPricing,
  providerLimits: limits, outputLimit: 32768, inputLimit: promptBytes, concurrency: 20,
  identity: { provider: 'openrouter', account: 'test', model: 'test/model', protocol: 'openrouter-chat-v1', providerLimits: limits,
    outputLimit: 32768, upperUsd: frozen(promptBytes) },
  profile: { policyId: 'runtime_payg', policyVersion: 'v1', profileVersion: 'v1', evidenceVersion: 'e1', pricingHash: nominalPricing.pricingHash,
    endpointTag: 'synthetic', nominalPricing, templateTokens: TEMPLATE, marginTokens: MARGIN, maxBytes: 196_608, maxMessages: 128, maxSchemaBytes: 16_384 } }) as unknown as ChatQuote;
const request = (bytes: number) => {
  const base = { model: 'test/model', stream: false, store: false, max_tokens: OUT, provider: openRouterBound(limits, 32768).routing,
    messages: [{ role: 'user', content: '' }] };
  const filler = bytes - Buffer.byteLength(JSON.stringify(base));
  return JSON.stringify({ ...base, messages: [{ role: 'user', content: 'x'.repeat(filler) }] });
};
const cost = (promptTokens: number, completionTokens: number) => promptTokens * 3 / 1e6 + completionTokens * 15 / 1e6;

describe('a call bounded on its request body', () => {
  it('is the price of that prompt and the review\'s output, far below the context-window bound that refused Sonnet under 1 USD', () => {
    const q = quote(16_500);
    expect(Number(openRouterBound(limits, 32768).upperUsd)).toBeGreaterThan(3);
    expect(Number(q.upperUsd)).toBeLessThan(1);
    const call = bodyBoundCall(q, request(14_000), OUT);
    expect(call.upperUsd).toBe(openRouterCallBound(limits, OUT, 14_000 + TEMPLATE + MARGIN).upperUsd);
    expect(call.identity).toMatchObject({ outputLimit: OUT, upperUsd: call.upperUsd, payg: { bytes: 14_000, promptTokensUpper: 14_000 + TEMPLATE + MARGIN } });
  });

  it('is never below the most the call can cost: a prompt at its token bound and an output of the full limit', () => {
    for (const bytes of [2_000, 14_000, 16_500, 60_000]) {
      const q = quote(bytes), call = bodyBoundCall(q, request(bytes), OUT);
      // A token is at least one byte, so the prompt cannot have more tokens than bytes + template + margin.
      expect(Number(call.upperUsd)).toBeGreaterThanOrEqual(cost(bytes + TEMPLATE + MARGIN, OUT) - 1e-9);
      expect(Number(call.upperUsd)).toBeLessThanOrEqual(Number(q.upperUsd));
    }
  });

  it('grows with the request and stops a request larger than the one the turn froze', () => {
    const q = quote(20_000);
    const small = bodyBoundCall(q, request(5_000), OUT), large = bodyBoundCall(q, request(20_000), OUT);
    expect(Number(large.upperUsd)).toBeGreaterThan(Number(small.upperUsd));
    expect(large.upperUsd).toBe(q.upperUsd);
    expect(() => bodyBoundCall(q, request(20_001), OUT)).toThrow(TurnStop);
    expect(() => bodyBoundCall(q, request(20_001), OUT)).toThrow('TURN_INPUT_TOO_LARGE');
  });

  it('refuses a body the profile does not cover', () => {
    const q = quote(20_000);
    expect(() => bodyBoundCall(q, JSON.stringify({ messages: [] }), OUT)).toThrow('TURN_INPUT_TOO_LARGE');
    expect(() => bodyBoundCall(q, JSON.stringify({ messages: [{ role: 'user', content: 'x' }], tools: [{}] }), OUT)).toThrow('TURN_INPUT_TOO_LARGE');
  });

  it('is accepted by the OpenRouter adapter on the same body and refused on any other', async () => {
    const q = quote(20_000), body = request(14_000), call = bodyBoundCall(q, body, OUT);
    const credential = vi.fn(async () => 'LOCAL_SYNTHETIC_KEY'), transport = vi.fn(async () => new Response('{}'));
    const adapter = openRouterAdapter({ credential, transport });
    await expect(adapter.prepareDispatch({ input: body }, call.identity)).resolves.toBeTypeOf('function');
    await expect(adapter.prepareDispatch({ input: request(14_001) }, call.identity)).rejects.toThrow('QUOTE_CONFLICT');
    // The quote's own (frozen) identity has no body measure: the adapter measures the context-window bound and refuses its smaller number.
    await expect(adapter.prepareDispatch({ input: body }, { ...call.identity, payg: undefined } as never)).rejects.toThrow('QUOTE_CONFLICT');
    expect(transport).not.toHaveBeenCalled();
  });
});

// PUBLISH-MONITOR B2: a screenshot quote carries the route's one-image allowance; the image is measured and inside U.
describe('a screenshot call bounded on its body and its one image', () => {
  const allowance = { maxDataUrlBytes: 819_223, maxEdge: 1600 };
  const imageLimits = { ...limits, imageUsd: '0' };
  const screenshotQuote = (promptBytes: number) => {
    const imageTokens = imageTokensUpper(1600, 1600);
    const upperUsd = openRouterCallBound(imageLimits, OUT, promptBytes + imageTokens + TEMPLATE + MARGIN, imageTokens).upperUsd;
    const q = quote(promptBytes) as unknown as { profile: object; identity: object; providerLimits: object };
    return { ...q, upperUsd, providerLimits: imageLimits, identity: { ...q.identity, providerLimits: imageLimits, upperUsd,
      phase: 'publish_monitor_screenshot' }, profile: { ...q.profile, imageInput: allowance } } as unknown as ChatQuote;
  };
  const withImage = (width: number, height: number, text = '读出后台指标') => JSON.stringify({ model: 'test/model', stream: false,
    store: false, max_tokens: OUT, provider: openRouterBound(imageLimits, 32768).routing,
    messages: [{ role: 'user', content: [{ type: 'text', text },
      { type: 'image_url', image_url: { url: JPEG_DATA_URL_PREFIX + syntheticJpeg(width, height).toString('base64') } }] }] });

  it('counts the measured image as prompt tokens, outside the text cap, and never above the frozen bound', () => {
    const q = screenshotQuote(4_000), body = withImage(1170, 1600), call = bodyBoundCall(q, body, OUT);
    const image = { width: 1170, height: 1600, tokensUpper: imageTokensUpper(1170, 1600) };
    expect(call.identity.payg).toMatchObject({ image });
    const text = Buffer.byteLength(body) - call.identity.payg!.image!.dataUrlBytes;
    expect(call.identity.payg!.promptTokensUpper).toBe(text + image.tokensUpper + TEMPLATE + MARGIN);
    expect(Number(call.upperUsd)).toBeGreaterThanOrEqual(cost(text + image.tokensUpper + TEMPLATE + MARGIN, OUT) - 1e-9);
    expect(Number(call.upperUsd)).toBeLessThanOrEqual(Number(q.upperUsd));
  });

  it('refuses an image above the allowance, a second image, no image, and an image on a quote without the allowance', () => {
    const q = screenshotQuote(4_000);
    expect(() => bodyBoundCall(q, withImage(2000, 1000), OUT)).toThrow('TURN_CALL_DENIED');
    const two = JSON.parse(withImage(800, 600));
    two.messages[0].content.push(two.messages[0].content[1]);
    expect(() => bodyBoundCall(q, JSON.stringify(two), OUT)).toThrow('TURN_CALL_DENIED');
    expect(() => bodyBoundCall(q, request(3_000), OUT)).toThrow('TURN_CALL_DENIED');
    expect(() => bodyBoundCall(quote(4_000), withImage(800, 600), OUT)).toThrow('TURN_CALL_DENIED');
  });

  it('is accepted by the OpenRouter adapter for the screenshot purpose only', async () => {
    const q = screenshotQuote(4_000), body = withImage(1170, 1600), call = bodyBoundCall(q, body, OUT);
    const credential = vi.fn(async () => 'LOCAL_SYNTHETIC_KEY'), transport = vi.fn(async () => new Response('{}'));
    const adapter = openRouterAdapter({ credential, transport });
    await expect(adapter.prepareDispatch({ input: body }, call.identity)).resolves.toBeTypeOf('function');
    await expect(adapter.prepareDispatch({ input: body }, { ...call.identity, phase: 'ordinary' } as never)).rejects.toThrow('REQUEST_DENIED');
    expect(transport).not.toHaveBeenCalled();
  });
});
