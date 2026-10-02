/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { normalizeEndpointPricing, priceIdentity } from '../../shared/modelPricing';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_BYTE_LIMIT, catalogModelPath, pricingHash, readOpenRouterCatalog, readOpenRouterPricing } from './openRouterCatalog';

// Shapes follow the public catalog as read on 2026-09-29 (trimmed); no network here.
const model = 'deepseek/deepseek-v4.1-flash';
const list = { data: [
  { id: 'qwen/qwen3.8-flash', reasoning: { mandatory: false, default_enabled: true, supports_max_tokens: true } },
  { id: model, name: 'DeepSeek', reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' } },
  { id: 'plain/model' },
] };
const endpoints = (id = model) => ({ data: { id, name: 'DeepSeek', endpoints: [
  { name: 'DeepInfra | x', tag: 'deepinfra', provider_name: 'DeepInfra', context_length: 1048576, max_completion_tokens: 64000,
    supported_parameters: ['tools', 'reasoning', 'reasoning_effort'], pricing: { prompt: '0.00000014' }, status: 0 },
  { name: 'Other | x', tag: 'sail-research/fp4', provider_name: 'Sail Research', context_length: null, max_completion_tokens: null, supported_parameters: ['reasoning'] },
] } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function transport(responses: Record<string, () => Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = String(url);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    const response = responses[key];
    if (!response) throw new Error('unexpected ' + key);
    return response();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const urls = (id = model) => ({ list: 'https://openrouter.ai/api/v1/models', endpoints: `https://openrouter.ai/api/v1/models/${id}/endpoints` });

describe('readOpenRouterCatalog', () => {
  it('reads only the two fixed keyless URLs and keeps the reasoning metadata and each route', async () => {
    const u = urls(), fetchMock = transport({ [u.list]: () => json(list), [u.endpoints]: () => json(endpoints()) });
    const { catalog: snapshot, pricing } = await readOpenRouterCatalog(model, fetchMock, () => new Date('2026-09-29T01:02:03.000Z'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pricing).toMatchObject({ fetchedAt: '2026-09-29T01:02:03.000Z', model, source: `openrouter:/api/v1/models/${model}/endpoints` });
    // The first route lacks a completion price, the second has no pricing at all: both kept, neither admissible.
    expect(pricing.endpoints.map(endpoint => [endpoint.tag, endpoint.admissible, endpoint.issues])).toEqual([
      ['deepinfra', false, ['BASE_PRICE_MISSING']], ['sail-research/fp4', false, ['PRICING_MISSING']],
    ]);
    expect(snapshot).toEqual({
      fetchedAt: '2026-09-29T01:02:03.000Z', model,
      reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'high', supportsMaxTokens: false },
      endpoints: [
        { tag: 'deepinfra', providerName: 'DeepInfra', supportedParameters: ['tools', 'reasoning', 'reasoning_effort'], contextLength: 1048576, maxCompletionTokens: 64000 },
        { tag: 'sail-research/fp4', providerName: 'Sail Research', supportedParameters: ['reasoning'], contextLength: null, maxCompletionTokens: null },
      ],
    });
  });

  it('records a model without catalog reasoning as having none', async () => {
    const u = urls('plain/model');
    const { catalog } = await readOpenRouterCatalog('plain/model', transport({ [u.list]: () => json(list), [u.endpoints]: () => json(endpoints('plain/model')) }));
    expect(catalog.reasoning).toBeNull();
  });

  it.each(['openrouter/auto', 'OpenRouter/fusion', '../models', 'deepseek/v4/../x', 'deepseek', 'deep seek/x', 'a/b?c', ''])(
    'refuses the id %j before any request', async id => {
      const fetchMock = transport({});
      await expect(readOpenRouterCatalog(id, fetchMock)).rejects.toThrow('MODEL_CATALOG_ID_INVALID');
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('encodes each path segment', () => {
    expect(catalogModelPath('qwen/qwen3.8-flash')).toBe('qwen/qwen3.8-flash');
  });

  it.each([
    ['a missing model', () => json({ data: [] }), () => json(endpoints()), 'MODEL_CATALOG_NOT_FOUND'],
    ['an endpoint 404', () => json(list), () => json({}, 404), 'MODEL_CATALOG_NOT_FOUND'],
    ['a server error', () => json(list), () => json({}, 500), 'MODEL_CATALOG_UNAVAILABLE'],
    ['malformed JSON', () => new Response('{"data":'), () => json(endpoints()), 'MODEL_CATALOG_INVALID'],
    ['endpoints of another model', () => json(list), () => json(endpoints('other/model')), 'MODEL_CATALOG_INVALID'],
    ['an endpoint without a tag', () => json(list), () => json({ data: { id: model, endpoints: [{ provider_name: 'X' }] } }), 'MODEL_CATALOG_INVALID'],
    ['an oversized body', () => new Response(new Uint8Array(CATALOG_BYTE_LIMIT + 1)), () => json(endpoints()), 'MODEL_CATALOG_TOO_LARGE'],
  ])('fails the whole read on %s', async (_name, listResponse, endpointResponse, code) => {
    const u = urls();
    await expect(readOpenRouterCatalog(model, transport({ [u.list]: listResponse, [u.endpoints]: endpointResponse }))).rejects.toThrow(code);
  });

  it('merges a duplicated tag with identical prices, keeps the smaller context and hashes prices stably', async () => {
    const u = urls(), price = { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000007', discount: 0 };
    const routes = { data: { id: model, endpoints: [
      { tag: 'baseten/fp8', provider_name: 'BaseTen', context_length: 1048576, pricing: price },
      { tag: 'baseten/fp8', provider_name: 'BaseTen', context_length: 262144, pricing: price },
    ] } };
    const read = () => readOpenRouterCatalog(model, transport({ [u.list]: () => json(list), [u.endpoints]: () => json(routes) }));
    const { pricing } = await read();
    expect(pricing.endpoints).toEqual([expect.objectContaining({ tag: 'baseten/fp8', contextLength: 262144, admissible: true })]);
    expect((await read()).pricing.pricingHash).toBe(pricing.pricingHash);
    expect(pricingHash([{ ...pricing.endpoints[0]!, base: { ...pricing.endpoints[0]!.base, prompt: '0.31' } }])).not.toBe(pricing.pricingHash);
  });
});


describe('pricing-only reads', () => {
  it('uses one keyless endpoint request and isolates extreme prices to the invalid route', async () => {
    const u = urls();
    const routes = { data: { id: model, endpoints: [
      { tag: 'good', provider_name: 'Good', context_length: 100, pricing: { prompt: '0.000001', completion: '0.000002' } },
      { tag: 'bad-token', provider_name: 'Bad', pricing: { prompt: '999.9999999999999999999', completion: '0.000002' } },
      { tag: 'bad-request', provider_name: 'Bad', pricing: { prompt: '0.000001', completion: '0.000002', request: '999999999.9999999999999' } },
    ] } };
    const fetchMock = transport({ [u.endpoints]: () => json(routes) });
    const pricing = await readOpenRouterPricing(model, fetchMock, () => new Date('2026-10-02T00:00:00.000Z'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pricing.fetchedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(pricing.endpoints.map(item => [item.tag, item.admissible])).toEqual([
      ['good', true], ['bad-token', false], ['bad-request', false],
    ]);
    for (const endpoint of pricing.endpoints.slice(1)) expect(endpoint.issues).toContain('PRICE_INVALID');
  });

  it('hashes endpoint tags in character-code order, independent of input ordering', () => {
    const endpoints = ['a', '_', 'Z', 'ä', 'A'].map(tag =>
      normalizeEndpointPricing(tag, 100, { prompt: '0.000001', completion: '0.000002' }));
    const ordered = ['A', 'Z', '_', 'a', 'ä'].map(tag => endpoints.find(item => item.tag === tag)!);
    const expected = createHash('sha256').update(ordered.map(item => JSON.stringify([item.tag, priceIdentity(item)])).join('\n')).digest('hex');
    expect(pricingHash(endpoints)).toBe(expected);
    expect(pricingHash([...endpoints].reverse())).toBe(expected);
  });
});

it('bounds a pricing-only request with the shared 15-second abort deadline', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fake = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  }));
  try {
    const pending = readOpenRouterPricing(model, fake);
    const refused = expect(pending).rejects.toThrow('synthetic timeout');
    expect(timeout).toHaveBeenCalledWith(15000);
    controller.abort();
    await refused;
    expect(fake).toHaveBeenCalledTimes(1);
  } finally { timeout.mockRestore(); }
});
