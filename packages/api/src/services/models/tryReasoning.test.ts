/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { TRY_PLAIN_MAX_TOKENS, TRY_URL, TryRefused, tryMaxTokens, tryReasoning, tryRequest } from './tryReasoning';

const model = 'deepseek/deepseek-v4.1-flash';
const reasoning = (purposes: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({ route: 'deepinfra/fp8', purposes, catalog: {
  fetchedAt: '2026-09-29T00:00:00.000Z', model,
  reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'high', supportsMaxTokens: true },
  endpoints: [{ tag: 'deepinfra/fp8', providerName: 'DeepInfra', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 100000, maxCompletionTokens: 8192 }],
  ...patch } });
const row = (purposes: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({ id: '11111111-1111-4111-8111-111111111111', name: 'DeepSeek', model_id: model,
  provider: 'openai', is_active: 'true', max_tokens: 8192, input_limit: 100000, api_key: ' SECRET_CANARY ', api_endpoint: '', config: { reasoning: reasoning(purposes) }, ...patch });
const off = { interactive: { mode: 'off', wire: 'reasoning_effort' } };
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
function sse(content: string, finish = 'stop', reasoningTokens = 0) {
  const chunk = (delta: unknown, finishReason: string | null = null) => frame({ id: 'gen-1', model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  return chunk({ role: 'assistant', content: '' }) + (content ? chunk({ content }) : '') + chunk({}, finish) +
    frame({ id: 'gen-1', model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: reasoningTokens }, cost: 0.00001 } }) +
    'data: [DONE]\n\n';
}

describe('tryRequest', () => {
  it('builds one fixed request on the configured route with the purpose setting', () => {
    const { body, maxTokens } = tryRequest(row(off), 'interactive');
    expect(body).toEqual({ model, messages: [{ role: 'user', content: '请用一句话介绍你自己。' }], max_tokens: TRY_PLAIN_MAX_TOKENS, stream: true,
      stream_options: { include_usage: true }, provider: { only: ['deepinfra/fp8'], allow_fallbacks: false, require_parameters: true }, reasoning_effort: 'none' });
    expect(maxTokens).toBe(256);
  });

  it('sizes the allowance so thinking cannot use up the reply', () => {
    expect(tryMaxTokens({ mode: 'off', wire: 'reasoning' }, true, 8192)).toBe(256);
    expect(tryMaxTokens({ mode: 'effort', effort: 'high', wire: 'reasoning_effort' }, true, 8192)).toBe(4096);
    expect(tryMaxTokens({ mode: 'budget', maxTokens: 2000 }, true, 8192)).toBe(3024);
    expect(tryMaxTokens({ mode: 'provider_default' }, true, 8192)).toBe(4096);
    expect(tryMaxTokens({ mode: 'provider_default' }, false, 8192)).toBe(256);
    expect(tryMaxTokens({ mode: 'effort', effort: 'high', wire: 'reasoning_effort' }, true, 3000)).toBe(3000);
  });

  it('uses the provider default for an unset organizer and refuses other unset purposes', () => {
    expect(tryRequest(row(off), 'organize').body).not.toHaveProperty('reasoning');
    expect(tryRequest(row(off), 'organize').body).not.toHaveProperty('reasoning_effort');
    expect(() => tryRequest(row(off), 'review')).toThrow(TryRefused);
  });

  it.each([
    ['an inactive model', row(off, { is_active: 'false' })],
    ['a missing key', row(off, { api_key: '' })],
    ['a config that fails its checks', row({ interactive: { mode: 'effort', effort: 'medium', wire: 'reasoning_effort' } })],
    ['no route', row(off, { config: { reasoning: { ...reasoning(off), route: null } } })],
  ])('refuses %s before any call', (_name, value) => {
    expect(() => tryRequest(value, 'interactive')).toThrow(TryRefused);
  });
});

describe('tryReasoning', () => {
  it('sends once with the stored key and reports measurements only', async () => {
    let now = 0;
    const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TRY_URL);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer SECRET_CANARY' } });
      now = 700;
      return new Response(sse('我是一个助手。'), { headers: { 'x-generation-id': 'gen-1' } });
    });
    const result = await tryReasoning(row(off), 'interactive', transport as unknown as typeof fetch, () => now);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, httpStatus: 200, firstTextMs: 700, hasText: true, finishReason: 'stop', truncated: false,
      reasoningTokens: 0, completionTokens: 5, costUsd: 0.00001, error: null });
    expect(JSON.stringify(result)).not.toMatch(/我是一个助手|SECRET_CANARY/);
  });

  it('marks a reply cut by the limit with no text', async () => {
    const transport = vi.fn(async () => new Response(sse('', 'length', 4096)));
    const result = await tryReasoning(row({ interactive: { mode: 'effort', effort: 'high', wire: 'reasoning_effort' } }), 'interactive', transport as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, hasText: false, truncated: true, reasoningTokens: 4096, maxTokens: 4096, firstTextMs: null });
  });

  it('reports a provider refusal with its bounded message and never retries', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'No endpoints found that can handle the requested parameters.' } }), { status: 404 }));
    const result = await tryReasoning(row(off), 'interactive', transport as unknown as typeof fetch);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, httpStatus: 404, error: 'HTTP_404', providerMessage: 'No endpoints found that can handle the requested parameters.' });
  });

  it('reports a transport failure without a retry', async () => {
    const transport = vi.fn(async () => { throw new Error('connection reset SECRET_CANARY'); });
    const result = await tryReasoning(row(off), 'interactive', transport as unknown as typeof fetch);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, httpStatus: null, error: 'TRANSPORT_FAILED', providerMessage: null });
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
});
