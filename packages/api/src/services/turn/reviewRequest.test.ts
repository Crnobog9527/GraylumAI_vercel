/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { bodyBoundCall } from './bodyBound';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound, openRouterCallBound } from './provider/openRouterPolicy';
import { FREE_CHAT_REQUEST_FORMAT, openRouterRequestBody, PLAIN_TEXT_STREAM } from './provider/providerRequest';
import { REQUEST_ROOM_BYTES, REVIEW_OUTPUT_TOKENS, reviewCallPolicy } from './review';
import type { ChatQuote } from './quote';

// The real request builder and the real OpenRouter adapter, with a Sonnet-class route (staging: 2.2 / 11 USD per million, 1M context).
const limits = { providerSlug: 'anthropic', contextTokens: 1_000_000, promptUsdPerMillion: '2.2', completionUsdPerMillion: '11', requestUsd: '0' };
const nominalPricing = { version: 'nominal-v1' as const, pricingHash: 'a'.repeat(64), endpointTag: 'anthropic',
  tiers: [{ minPromptTokens: 0, prompt: '2.2', completion: '11', request: '0' }], timeOfDay: [] };
const text = 'pack'.repeat(2500), instructions = 'coach instructions '.repeat(80);
const promptBytes = Buffer.byteLength(text) + Buffer.byteLength(instructions) + REQUEST_ROOM_BYTES;
const frozen = openRouterCallBound(limits, REVIEW_OUTPUT_TOKENS, promptBytes + 8192).upperUsd;
const quote = { modelId: 'm', model: 'anthropic/claude-sonnet-5.5', q: '100', multiplier: '6', upperUsd: frozen, pricing: nominalPricing,
  providerLimits: limits, outputLimit: 32768, inputLimit: promptBytes, concurrency: 20, reasoning: { effort: 'low' },
  identity: { provider: 'openrouter', account: 'acct', model: 'anthropic/claude-sonnet-5.5', protocol: 'openrouter-chat-v1',
    providerLimits: limits, outputLimit: 32768, upperUsd: frozen },
  profile: { policyId: 'runtime_payg', policyVersion: 'v1', profileVersion: 'v1', evidenceVersion: 'e1', pricingHash: nominalPricing.pricingHash,
    endpointTag: 'anthropic', nominalPricing, templateTokens: 4096, marginTokens: 4096, maxBytes: 196_608, maxMessages: 128,
    maxSchemaBytes: 16_384 } } as unknown as ChatQuote;

it('the review\'s request is built under its policy, carries the review\'s output limit, and is accepted by the adapter under the body-measured bound', async () => {
  // What the SDK sends for modelSettings.maxTokens = 2000 and the frozen reasoning effort: max_tokens covers the reasoning tokens too.
  const original = JSON.stringify({ model: quote.model, stream: false, store: false, max_tokens: REVIEW_OUTPUT_TOKENS, reasoning_effort: 'low',
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: text }] });
  const context = { providerRequestFormat: FREE_CHAT_REQUEST_FORMAT, textStream: PLAIN_TEXT_STREAM, tools: [], network: 'deny',
    reasoning: quote.reasoning };
  const policy = reviewCallPolicy(quote);
  // The policy's own bound is the context-window one that the builder re-checks; the call's money bound is far lower.
  expect(policy.upperUsd).toBe(openRouterBound(limits, 32768).upperUsd);
  const body = openRouterRequestBody(original, { context: context as never, policy: policy as never, phase: 'ordinary', primaryDialogue: true });
  expect(JSON.parse(body).max_tokens).toBe(REVIEW_OUTPUT_TOKENS);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(promptBytes);
  const call = bodyBoundCall(quote, body, REVIEW_OUTPUT_TOKENS);
  expect(Number(call.upperUsd)).toBeLessThan(0.3);
  expect(Number(call.upperUsd)).toBeLessThanOrEqual(Number(quote.upperUsd));
  const transport = vi.fn(async () => new Response('{}'));
  await expect(openRouterAdapter({ credential: async () => 'KEY', transport }).prepareDispatch({ input: body }, call.identity))
    .resolves.toBeTypeOf('function');
  expect(transport).not.toHaveBeenCalled();
});
