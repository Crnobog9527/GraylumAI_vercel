/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countWorkbenchTokens, echoesPrivateMethod, sealGenerationReceipt, openGenerationReceipt, generationInput, openRouterGeneration, type ModelRequest } from '../artifacts/generation';
import { activateSkill, identityOf, packageHash, type SkillSource } from '../skills/loader';
import { makePackage } from './fixtures/artifacts';
const model: ModelRequest['model'] = { id: '00000000-0000-4000-8000-000000000001', model_id: 'openai/gpt-4o-mini-2024-07-18', is_active: 'true', max_tokens: 4096, input_limit: 128000, api_key: 'SYNTHETIC_ONLY', api_endpoint: 'https://openrouter.ai/api/v1', token_counting_supported: 'true', tokenizer_family: 'o200k_base' };
const request: ModelRequest = { model, messages: [{ role: 'system', content: 'synthetic method' }, { role: 'user', content: 'fictional content' }], maxTokens: 100 };
afterEach(() => vi.unstubAllGlobals());
describe('workbench model boundary', () => {
  it('sends one bounded text-only request to the fixed endpoint with no tool loop or redirects', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Synthetic result' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } })));
    vi.stubGlobal('fetch', fetch);
    expect(await openRouterGeneration(request)).toEqual({ body: 'Synthetic result', inputTokens: 100, outputTokens: 10 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options.redirect).toBe('error');
    expect(JSON.parse(String(options.body))).toMatchObject({ tools: [], plugins: [], tool_choice: 'none', stream: false, max_tokens: 100, provider: { allow_fallbacks: false } });
  });
  it.each(['https://attacker.invalid', 'http://127.0.0.1:1234', 'https://openrouter.ai@attacker.invalid'])('rejects unreviewed endpoint %s before fetch', async endpoint => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(openRouterGeneration({ ...request, model: { ...model, api_endpoint: endpoint as never } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { choices: [{ finish_reason: 'length', message: { content: 'partial' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { choices: [{ finish_reason: 'stop', message: { content: 'tools', tool_calls: [{}] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { choices: [{ finish_reason: 'stop', message: { content: 'missing usage' } }] },
  ])('does not turn incomplete, tool or unmetered output into a billable candidate', async body => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(body))); vi.stubGlobal('fetch', fetch);
    await expect(openRouterGeneration(request)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds streamed response bytes and does not retry a failed provider response', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(131073))); vi.stubGlobal('fetch', fetch);
    await expect(openRouterGeneration(request)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('counts complete multilingual input with framing; special-token-like text remains data', () => {
    const a = countWorkbenchTokens([{ role: 'user', content: '中文 <|endoftext|> 🐈' }]);
    const b = countWorkbenchTokens([{ role: 'user', content: '中文 <|endoftext|> 🐈'.repeat(200) }]);
    expect(a).toBeGreaterThan(1024); expect(b).toBeGreaterThan(a);
  });
  it('rejects browser-supplied actor, model, price, resources and malformed budget', () => {
    const base = { projectId: model.id, roundId: model.id, requestId: model.id, stepId: 'step-0', expectedSteps: { 'step-0': { version: 0, reviewVersion: 0 } }, quoteHash: 'a'.repeat(64), budgetCredits: 100 };
    expect(generationInput.safeParse(base).success).toBe(true);
    for (const extra of [{ actorId: model.id }, { model }, { price: 1 }, { resources: ['secret.md'] }, { budgetCredits: -1 }]) expect(generationInput.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
it('workflow resource selection loads entry and transitive closure without changing legacy tasks or reading unrelated methods', async () => {
  const p = makePackage(); p.descriptor.tasks = { legacy: ['references/step-2.md'] };
  p.descriptor.files.find(f => f.path === 'references/step-0.md')!.requires = ['references/step-1.md'];
  p.descriptor.packageHash = packageHash(p.descriptor);
  const read = vi.fn(async (identity: { path: string }) => Buffer.from(p.files.find(f => f.path === identity.path)!.base64, 'base64'));
  const source: SkillSource = { list: async () => [p.descriptor], state: async () => 'enabled', read };
  const loaded = await activateSkill(source, identityOf(p.descriptor), { resources: ['references/step-0.md'], maxContextBytes: 10000 });
  expect(loaded.resourceIdentities().map(r => r.path).sort()).toEqual(['SKILL.md', 'references/step-0.md', 'references/step-1.md']);
  expect(JSON.stringify(loaded)).not.toContain('METHOD_CANARY');
  await expect(activateSkill(source, identityOf(p.descriptor), { task: 'legacy', resources: ['references/step-0.md'], maxContextBytes: 10000 })).rejects.toThrow('INVALID_IDENTITY');
  const legacy = await activateSkill(source, identityOf(p.descriptor), { task: 'legacy', maxContextBytes: 10000 });
  expect(legacy.resourceIdentities().map(r => r.path)).toEqual(['SKILL.md', 'references/step-2.md']);
  read.mockClear();
  await expect(activateSkill(source, identityOf(p.descriptor), { resources: ['references/step-0.md'], maxContextBytes: 1 })).rejects.toThrow('CAPACITY_EXCEEDED');
  expect(read).not.toHaveBeenCalled();
});

it('blocks private resource echoes including punctuation-obfuscated identifiers without blocking unrelated output', () => {
  const context = JSON.stringify({ resources: [{ path: 'references/private-method.md', content: 'METHOD_CANARY. 严格保护内部流程的第二阶段操作细节。' }] });
  for (const body of ['METHOD_CANARY', 'M E T H O D _ C A N A R Y', '严格保护内部流程的第二阶段操作细节', 'references/private-method.md']) expect(echoesPrivateMethod(body, context)).toBe(true);
  expect(echoesPrivateMethod('A useful fictional project candidate.', context)).toBe(false);
});
it('authenticates encrypted receipt contents and user/project/request binding, independently of process memory', () => {
  const result = { body: 'Known model result', inputTokens: 20, outputTokens: 10, credits: 1, costUsd: 0.001 };
  const sealed = sealGenerationReceipt(result, model.id, 'owner/project/round/request');
  expect(sealed).not.toContain(result.body);
  expect(openGenerationReceipt(sealed, model.id, 'owner/project/round/request')).toEqual(result);
  expect(() => openGenerationReceipt(sealed, model.id, 'other-owner/project/round/request')).toThrow();
  expect(() => openGenerationReceipt(sealed, 'different-secret', 'owner/project/round/request')).toThrow();
  const bytes = Buffer.from(sealed, 'base64url'); bytes[35] ^= 1;
  expect(() => openGenerationReceipt(bytes.toString('base64url'), model.id, 'owner/project/round/request')).toThrow();
});
