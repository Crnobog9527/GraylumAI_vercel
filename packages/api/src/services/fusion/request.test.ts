/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { FUSION_INPUT_CAP, fusionRequestBody } from './request';

const providerLimits = { providerSlug: 'anthropic', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' };
const policy = { modelId: '00000000-0000-4000-8000-000000000001', provider: 'openrouter', account: 'synthetic', model: 'anthropic/claude-sonnet-5.5',
  protocol: 'openrouter-chat-v1' as const, providerLimits, upperUsd: openRouterBound(providerLimits, 8192).upperUsd, inputLimit: 196608,
  outputLimit: 8192, automaticRetry: false as const, hiddenTools: false as const, lookupSupported: true };
const request = { instructions: 'Review the report against the rubric.', input: 'REPORT: synthetic',
  responseFormat: { type: 'json_schema', json_schema: { name: 'review', strict: true, schema: { type: 'object' } } } };

describe('Fusion request bytes', () => {
  it('has only host messages, no tools, web plugin off, streamed with usage', () => {
    const body = JSON.parse(fusionRequestBody(policy, request, 4096, { effort: 'low' }));
    expect(body.messages).toEqual([{ role: 'system', content: request.instructions }, { role: 'user', content: request.input }]);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('web_search_options');
    expect(body.plugins).toEqual([{ id: 'web', enabled: false }]);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, store: false, max_tokens: 4096,
      reasoning_effort: 'low', response_format: request.responseFormat, provider: openRouterBound(providerLimits, 8192).routing });
    expect(JSON.stringify(body)).not.toMatch(/Graylum/);
  });
  it('refuses built-in search models and :online aliases', () => {
    for (const model of ['perplexity/sonar', 'openrouter/auto', 'acme/search-pro', 'anthropic/claude-sonnet-5.5:online'])
      expect(() => fusionRequestBody({ ...policy, model }, request, 4096)).toThrow();
  });
  it('rejects an input snapshot over 90000 bytes before any freeze', () => {
    expect(FUSION_INPUT_CAP).toBe(90000);
    expect(() => fusionRequestBody(policy, { ...request, input: '好'.repeat(30001) }, 4096)).toThrow('FUSION_INPUT_TOO_LARGE');
    expect(() => fusionRequestBody(policy, { ...request, input: 'x'.repeat(90000) }, 4096)).not.toThrow();
  });
  it('is accepted by the provider adapter exactly as built', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'));
    const adapter = openRouterAdapter({ credential: async () => 'LOCAL_SYNTHETIC_KEY', transport });
    const body = fusionRequestBody(policy, { instructions: 'x', input: 'y' }, 4096);
    await adapter.dispatch({ input: body }, { ...policy, outputLimit: 4096,
      upperUsd: openRouterBound(providerLimits, 4096).upperUsd });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
  });
});
