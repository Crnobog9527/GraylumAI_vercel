/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { defaultModelFirst, freeChatModels } from './defaultModel';
import type { PaygHostProfile } from './paygHostPolicy';
import type { StagingPolicy } from './stagingPolicy';
import { configuredReasoning } from '../__tests__/fixtures/runtimeReasoning';

const sol = { id: 'sol', name: 'gpt-6.1-sol' }, luna = { id: 'luna', name: 'gpt-6-luna' };
const sonnet = { id: 'sonnet', name: 'claude-sonnet-5.5' }, gemini = { id: 'gemini', name: 'Gemini 3.8 Flash' };
const listed = [sol, luna, sonnet, gemini];
function admin(result: { data: { value: unknown } | null; error: unknown }) {
  const eq = vi.fn(() => ({ maybeSingle: async () => result }));
  const from = vi.fn(() => ({ select: () => ({ eq }) }));
  return { client: { from } as unknown as SupabaseClient, from, eq };
}

it('moves the administrator default to the front and keeps the rest in order', async () => {
  const f = admin({ data: { value: 'sonnet' }, error: null });
  expect(await defaultModelFirst(f.client, listed)).toEqual([sonnet, sol, luna, gemini]);
  expect(f.from).toHaveBeenCalledWith('system_settings');
  expect(f.eq).toHaveBeenCalledWith('key', 'primary_model_id');
});

it.each([
  ['missing', { data: null, error: null }],
  ['not offered in this window', { data: { value: 'retired-model' }, error: null }],
  ['not a string', { data: { value: { id: 'sonnet' } }, error: null }],
  ['unreadable', { data: null, error: { code: '42501' } }],
])('keeps the original order when the default is %s', async (_case, result) => {
  const models = [...listed];
  expect(await defaultModelFirst(admin(result).client, models)).toEqual(listed);
  expect(models).toEqual(listed);
});

// Staging-shaped synthetic configuration: Sonnet/Gemini evidenced for free chat, Luna only for
// organizing, Sol quoted in the window but without any per-call billing profile.
const windowId = '10000000-0000-4000-8000-000000000001';
const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'fixture-project', V3_RUNTIME_STAGING_PROJECT_ID: 'fixture-project',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'fixture.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co',
  V3_RUNTIME_STAGING_WINDOW_ID: windowId, V3_RUNTIME_STAGING_ENABLED: 'true' };
const routes = { sonnet: ['anthropic/claude-sonnet-5.5', 'anthropic'], gemini: ['google/gemini-3.8-flash', 'google-ai-studio'],
  luna: ['openai/gpt-6-luna', 'openai'], sol: ['openai/gpt-6.1-sol', 'openai'] } as const;
function profile(key: 'sonnet' | 'gemini' | 'luna', purposes: PaygHostProfile['purposes']): PaygHostProfile {
  const variant = { outputLimit: 8192, testedOutputLimit: 512, evidenceReference: 'test-only', manifestHash: 'b'.repeat(64),
    outputStressSamples: 2, includesReasoning: true as const };
  return { model: routes[key][0], endpointTag: routes[key][1], protocol: 'openrouter-chat-v1', profileVersion: 'test-only',
    evidenceVersion: 'test-only', admissionPath: 'empirical', templateTokens: 4096, marginTokens: 4096, maxBytes: 196608,
    maxMessages: 128, maxTools: 2, maxSchemaBytes: 16384, purposes,
    requestFormats: ['agent-turn-v5-stream', 'serial-tools-v4-stream', 'serial-tools-v6-reasoning'],
    reasoningVariants: [{ ...variant, reasoning: { parameter: 'none' } }, { ...variant, reasoning: { effort: 'low' } }],
    outputLimit: 8192, expiresAt: '2099-01-01T00:00:00Z',
    evidence: { reference: 'test-only', manifestHash: 'a'.repeat(64), distinctSamples: 60, messageStressSamples: 12,
      maxVerifiedMessages: 128, completeCells: 15, variantsPerCell: 4, maxPromptToBytes: 0.5, maxPromptToUpper: 0.4,
      outputLimit: 8192, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning', includesReasoning: true,
      cacheCovered: true, costBoundPassed: true } };
}
function staging(settingValue: unknown, settingError: unknown = null) {
  const keys = ['sol', 'luna', 'sonnet', 'gemini'] as const;
  const rows = keys.map(key => {
    const reasoning = configuredReasoning(routes[key][0], { mode: 'effort', effort: 'low', wire: 'reasoning_effort' }).reasoning;
    return { id: key, name: key, model_id: routes[key][0], max_tokens: 8192, config: { reasoning: { ...reasoning, route: routes[key][1],
      catalog: { ...reasoning.catalog!, endpoints: reasoning.catalog!.endpoints.map(e => ({ ...e, tag: routes[key][1] })) } } } };
  });
  const window: StagingPolicy = { id: windowId, creditsPerUsd: '100', multiplier: '6', expiresAt: '2099-01-01T00:00:00Z',
    callPolicies: keys.map(key => ({ modelId: key, model: routes[key][0], provider: 'openrouter', account: 'test-only',
      protocol: 'openrouter-chat-v1' as const, inputLimit: 196608, outputLimit: 8192, upperUsd: '1', automaticRetry: false as const,
      hiddenTools: false as const, lookupSupported: true, providerLimits: { providerSlug: routes[key][1], contextTokens: 1000000,
        promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' } })) };
  const reads = vi.fn(async () => ({ data: settingValue === undefined ? null : { value: settingValue }, error: settingError }));
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: reads }) }) }) } as unknown as SupabaseClient;
  return { rows, window, client, reads };
}
const config = { version: 1, enabled: true, windowId,
  profiles: [profile('sonnet', ['skill', 'report', 'ordinary', 'skill_matching']), profile('gemini', ['skill', 'report', 'ordinary', 'skill_matching']),
    profile('luna', ['organizer', 'attached_organizer'])] };

it('offers only models a free-chat turn can be admitted with (Sol has no billing profile, Luna only organizes)', async () => {
  const f = staging(config);
  expect(await freeChatModels(f.client, f.window, f.rows, env)).toEqual([{ id: 'sonnet', name: 'sonnet' }, { id: 'gemini', name: 'gemini' }]);
});

it('hides a model whose interactive reasoning is missing even if its route has a profile', async () => {
  const f = staging(config);
  f.rows[2]!.config.reasoning.purposes = {};
  expect((await freeChatModels(f.client, f.window, f.rows, env)).map(m => m.id)).toEqual(['gemini']);
});

it.each([
  ['per-call billing is off', { enabled: false }, null],
  ['the setting is absent', undefined, null],
  ['the setting is unreadable', undefined, { code: '57014' }],
])('hides nothing when %s; admission decides and reports the reason', async (_case, value, error) => {
  const f = staging(value, error);
  expect((await freeChatModels(f.client, f.window, f.rows, env)).map(m => m.id)).toEqual(['sol', 'luna', 'sonnet', 'gemini']);
});

it('uses admission\'s output ceiling: a quote above the evidenced profile hides the model unless the model row caps it', async () => {
  const f = staging(config);
  const sonnet = f.window.callPolicies.find(p => p.modelId === 'sonnet')!;
  sonnet.outputLimit = 32768;f.rows[2]!.max_tokens = 64000;
  expect((await freeChatModels(f.client, f.window, f.rows, env)).map(m => m.id)).toEqual(['gemini']);
  f.rows[2]!.max_tokens = 8192;
  expect((await freeChatModels(f.client, f.window, f.rows, env)).map(m => m.id)).toEqual(['sonnet', 'gemini']);
});

it('uses admission\'s deadline: a profile valid for the next hour stays offered even if it ends before the window', async () => {
  const soon = new Date(Date.now() + 2 * 3600000).toISOString();
  const f = staging({ ...config, profiles: config.profiles.map(p => ({ ...p, expiresAt: soon })) });
  expect((await freeChatModels(f.client, f.window, f.rows, env)).map(m => m.id)).toEqual(['sonnet', 'gemini']);
  const g = staging({ ...config, profiles: config.profiles.map(p => ({ ...p, expiresAt: new Date(Date.now() + 1800000).toISOString() })) });
  expect(await freeChatModels(g.client, g.window, g.rows, env)).toEqual([]);
});
