/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { normalizeEndpointPricing } from '../modelPricing';
export function pricedModel(cache: string | undefined = '0.00000025') {
  return { model_id: 'openai/example', config: {
    pricing: { model: 'openai/example', fetchedAt: '2026-10-02T00:00:00.000Z', source: 'fixture', pricingHash: 'a'.repeat(64),
      endpoints: [normalizeEndpointPricing('openai', 1000000, { prompt: '0.000002', completion: '0.000005',
        ...(cache === undefined ? {} : { input_cache_read: cache }),
        overrides: [{ min_prompt_tokens: 200000, prompt: '0.000003' }] })] },
    reasoning: { route: 'openai', purposes: {}, catalog: { model: 'openai/example', fetchedAt: '2026-10-02T00:00:00.000Z',
      reasoning: null, endpoints: [{ tag: 'openai', providerName: 'OpenAI', supportedParameters: [],
        contextLength: 1000000, maxCompletionTokens: 128000 }] } },
  } };
}
