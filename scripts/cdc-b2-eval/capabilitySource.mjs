/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { join } from 'node:path';
import { root as reasoningRoot, assert, read, variant as reasoningVariant } from './reasoningSource.mjs';

export const root = join(reasoningRoot, '../cdc-capability-20261006');
export const profiles = Object.freeze({
  sonnet: { model: 'anthropic/claude-sonnet-5.5', tag: 'anthropic', provider: 'Anthropic', prompt: 4, completion: 10 },
  gemini: { model: 'google/gemini-3.8-flash', tag: 'google-ai-studio', provider: 'Google AI Studio', prompt: 0.75, completion: 3.75 },
});

export function variant(raw, profile) {
  const config = profiles[profile];
  assert(config, 'MODEL_PROFILE');
  // Reuse the frozen source shape/route/absence-of-reasoning validation.
  reasoningVariant(raw, 'low');
  const body = JSON.parse(raw);
  body.model = config.model;
  body.provider.only = [config.tag];
  body.provider.max_price = { prompt: config.prompt, completion: config.completion, request: 0 };
  const next = JSON.stringify(body);
  assert(Buffer.byteLength(next) <= 64000, 'REQUEST_INPUT_LIMIT');
  return next;
}

export function reserveNano(raw, profile) {
  const config = profiles[profile];
  assert(config, 'MODEL_PROFILE');
  // No cache discount assumed. Input ceiling covers catalog cache-write tiers as well.
  return Math.ceil((Buffer.byteLength(raw) + 8192) * config.prompt * 1000 + 2048 * config.completion * 1000);
}

export async function catalog() {
  return Object.fromEntries(Object.entries(profiles).map(([name, config]) => {
    const metadata = read(join(root, `${config.tag}-catalog.json`));
    const endpoint = metadata.endpoint;
    assert(metadata.status === 200 && metadata.listed?.id === config.model && endpoint?.tag === config.tag &&
      endpoint.model_id === config.model && endpoint.provider_name === config.provider, 'CATALOG_MODEL_ROUTE');
    assert(endpoint.supported_parameters.includes('max_tokens') && endpoint.max_completion_tokens >= 2048 &&
      endpoint.context_length >= 64000 + 8192 + 2048, 'CATALOG_FORMAT_UNSUPPORTED');
    for (const price of [endpoint.pricing, ...(endpoint.pricing.overrides ?? [])]) {
      const inputs = [price.prompt, price.input_cache_write ?? price.prompt, price.input_cache_write_1h ?? price.prompt];
      assert(inputs.every(p => Number.isFinite(Number(p)) && Number(p) >= 0 && Number(p) <= config.prompt / 1e6) &&
        Number(price.completion) >= 0 && Number(price.completion) <= config.completion / 1e6 &&
        Number(price.request ?? 0) === 0, 'CATALOG_PRICE_BOUND');
    }
    return [name, metadata];
  }));
}
