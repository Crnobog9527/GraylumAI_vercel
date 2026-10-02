/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OPENROUTER_MODEL_ID, catalogSnapshot, type CatalogSnapshot } from '../../shared/modelReasoning';
import { mergeDuplicateTags, normalizeEndpointPricing, priceIdentity, pricingSnapshot, type PricingSnapshot } from '../../shared/modelPricing';

/** Only these two public, keyless catalog reads. No credential is ever sent. */
const CATALOG_BASE = 'https://openrouter.ai/api/v1/';
export const CATALOG_TIMEOUT_MS = 15_000;
/** The full model list is about 0.75 MB (2026-09-29); the cap leaves room without unbounded reads. */
export const CATALOG_BYTE_LIMIT = 8 * 1024 * 1024;

const count = z.number().int().positive().nullish().transform(value => value ?? null);
const listedModel = z.object({
  id: z.string(),
  reasoning: z.object({
    mandatory: z.boolean().optional(),
    default_enabled: z.boolean().nullish(),
    supported_efforts: z.array(z.string().max(32)).max(16).optional(),
    default_effort: z.string().max(32).nullish(),
    supports_max_tokens: z.boolean().optional(),
  }).passthrough().nullish(),
}).passthrough();
const modelList = z.object({ data: z.array(z.unknown()).max(5000) }).passthrough();
const endpointList = z.object({
  data: z.object({
    id: z.string(),
    endpoints: z.array(z.object({
      tag: z.string().min(1).max(128),
      provider_name: z.string().max(128),
      supported_parameters: z.array(z.string().max(64)).max(64).optional(),
      context_length: count,
      max_completion_tokens: count,
    }).passthrough()).max(64),
  }).passthrough(),
}).passthrough();

/** The catalog path segments of a model id, only after the Runtime's id check. */
export function catalogModelPath(model: string): string {
  if (!OPENROUTER_MODEL_ID.test(model) || model.toLowerCase().startsWith('openrouter/')) throw new Error('MODEL_CATALOG_ID_INVALID');
  return model.split('/').map(encodeURIComponent).join('/');
}

async function readJson(transport: typeof fetch, path: string): Promise<unknown> {
  const response = await transport(CATALOG_BASE + path, {
    method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(response.status === 404 ? 'MODEL_CATALOG_NOT_FOUND' : 'MODEL_CATALOG_UNAVAILABLE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('MODEL_CATALOG_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > CATALOG_BYTE_LIMIT) throw new Error('MODEL_CATALOG_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('MODEL_CATALOG_INVALID');
  }
}

export type CatalogRead = { catalog: CatalogSnapshot; pricing: PricingSnapshot };

/** sha256 of every route's normalized prices, in tag order. */
export function pricingHash(endpoints: PricingSnapshot['endpoints']): string {
  const lines = [...endpoints].sort((a, b) => a.tag.localeCompare(b.tag)).map(endpoint => JSON.stringify([endpoint.tag, priceIdentity(endpoint)]));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Reads the public OpenRouter catalog for one model: its reasoning metadata
 * from the model list, each provider route's parameters, and each route's
 * prices (MODEL-PRICING-SYNC). Any unexpected catalog shape fails the whole
 * read, so a stored snapshot is never partial; a route whose prices cannot
 * be represented is kept and marked not admissible instead.
 */
export async function readOpenRouterCatalog(model: string, transport: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<CatalogRead> {
  const path = catalogModelPath(model);
  const [list, endpoints] = await Promise.all([readJson(transport, 'models'), readJson(transport, 'models/' + path + '/endpoints')]);
  const models = modelList.safeParse(list);
  const routes = endpointList.safeParse(endpoints);
  if (!models.success || !routes.success) throw new Error('MODEL_CATALOG_INVALID');
  if (routes.data.data.id !== model) throw new Error('MODEL_CATALOG_INVALID');
  const listed = models.data.data.map(item => listedModel.safeParse(item)).find(item => item.success && item.data.id === model);
  if (!listed?.success) throw new Error('MODEL_CATALOG_NOT_FOUND');
  const reasoning = listed.data.reasoning;
  const fetchedAt = now().toISOString();
  const snapshot = catalogSnapshot.safeParse({
    fetchedAt,
    model,
    reasoning: reasoning ? {
      mandatory: reasoning.mandatory ?? false,
      defaultEnabled: reasoning.default_enabled ?? null,
      supportedEfforts: reasoning.supported_efforts ?? [],
      defaultEffort: reasoning.default_effort ?? null,
      supportsMaxTokens: reasoning.supports_max_tokens ?? false,
    } : null,
    endpoints: routes.data.data.endpoints.map(endpoint => ({
      tag: endpoint.tag,
      providerName: endpoint.provider_name,
      supportedParameters: endpoint.supported_parameters ?? [],
      contextLength: endpoint.context_length,
      maxCompletionTokens: endpoint.max_completion_tokens,
    })),
  });
  if (!snapshot.success) throw new Error('MODEL_CATALOG_INVALID');
  const priced = mergeDuplicateTags(routes.data.data.endpoints
    .map(endpoint => normalizeEndpointPricing(endpoint.tag, endpoint.context_length, endpoint.pricing)));
  const pricing = pricingSnapshot.safeParse({
    fetchedAt, model, source: `openrouter:/api/v1/models/${path}/endpoints`, pricingHash: pricingHash(priced), endpoints: priced,
  });
  if (!pricing.success) throw new Error('MODEL_CATALOG_INVALID');
  return { catalog: snapshot.data, pricing: pricing.data };
}
