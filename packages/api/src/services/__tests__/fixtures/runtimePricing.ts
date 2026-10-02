/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PricingSnapshot } from '../../../shared/modelPricing';
import type { CatalogSnapshot } from '../../../shared/modelReasoning';

/** Synthetic current prices. No provider or database transport. */
export function pricingConfig(model: string, tag = 'synthetic/fp8', prompt = '0.1', completion = '0.1') {
  const fetchedAt = new Date().toISOString();
  const pricing: PricingSnapshot = {
    model, fetchedAt, source: `openrouter:/api/v1/models/${model}/endpoints`, pricingHash: 'a'.repeat(64),
    endpoints: [{ tag, contextLength: 1050000, admissible: true, issues: [], unknownKeys: [],
      discount: null, base: { prompt, completion }, overrides: [], raw: {} }],
  };
  const catalog: CatalogSnapshot = { model, fetchedAt, reasoning: null,
    endpoints: [{ tag, providerName: 'Synthetic', supportedParameters: [], contextLength: 1050000, maxCompletionTokens: 8192 }],
  };
  return { pricing, reasoning: { catalog, route: tag, purposes: {} } };
}
