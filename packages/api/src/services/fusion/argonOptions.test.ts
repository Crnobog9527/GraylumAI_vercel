/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openRouterAccount } from '../models/openRouterKey';
import { fusionModelOptions } from './settingsAdmin';
import type { StagingPolicy } from '../runtime/stagingPolicy';

vi.mock('../models/openRouterKey', async original => ({
  ...(await original<typeof import('../models/openRouterKey')>()), readOpenRouterKey: async () => 'SYNTHETIC_ARGON_KEY',
  readOpenRouterKeyOrUnset: async () => 'SYNTHETIC_ARGON_KEY',
}));

const id = '7169edbf-aaa2-414e-ad6d-f79d0751dc16';
const windowId = '00000000-0000-4000-8000-000000000009';
const model = 'google/gemini-4-argon';
const env = { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com',
  VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  VERCEL_PROJECT_ID: 'fixture-project', V3_RUNTIME_STAGING_PROJECT_ID: 'fixture-project',
  V3_RUNTIME_STAGING_DATABASE_HOST: 'fixture.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co',
  V3_RUNTIME_STAGING_WINDOW_ID: windowId, V3_RUNTIME_STAGING_ENABLED: 'true' };

function fixture() {
  // Entirely synthetic configuration for a local database double, not real model evidence or a deployable profile.
  const evidence = { scope: 'fusion-request-shape', reference: 'synthetic-only', manifestHash: 'a'.repeat(64),
    distinctSamples: 6, sizeBands: 2, maxVerifiedBytes: 186000, maxPromptToBytes: 0.4, maxPromptToUpper: 0.38,
    outputLimit: 4096, testedOutputLimit: 512, outputSemantics: 'max-tokens-includes-reasoning',
    includesReasoning: true, cacheCovered: true, costBoundPassed: true };
  const profile = { model, endpointTag: 'google-ai-studio', protocol: 'openrouter-chat-v1',
    profileVersion: 'synthetic-only', evidenceVersion: 'synthetic-only', admissionPath: 'empirical',
    templateTokens: 4096, marginTokens: 4096, maxBytes: 196608, maxMessages: 128, maxTools: 2, maxSchemaBytes: 16384,
    purposes: ['fusion_review'], requestFormats: ['fusion-json-v1-stream'], outputLimit: 4096,
    reasoningVariants: [{ reasoning: { effort: 'low' }, outputLimit: 4096, testedOutputLimit: 512,
      evidenceReference: 'synthetic-only', manifestHash: 'a'.repeat(64), outputStressSamples: 2, includesReasoning: true }],
    evidence, expiresAt: '2099-01-01T00:00:00Z' };
  const profiles = [profile];
  const row = { id, name: 'Gemini 4 Argon', model_id: model, provider: 'openai', is_active: 'true',
    api_endpoint: 'https://openrouter.ai/api/v1', input_limit: 1048576, max_tokens: 943718,
    config: { reasoning: { route: 'google-ai-studio', purposes: {
      review: { mode: 'effort', effort: 'low', wire: 'reasoning_effort' },
    }, catalog: { model, fetchedAt: '2026-10-21T00:00:00Z', reasoning: {
      mandatory: true, defaultEnabled: null, supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium', supportsMaxTokens: false,
    }, endpoints: [{ tag: 'google-ai-studio', providerName: 'Google AI Studio', supportedParameters: ['reasoning_effort'],
      contextLength: 1048576, maxCompletionTokens: 943718 }] } } } };
  const window: StagingPolicy = { id: windowId, creditsPerUsd: '100', multiplier: '3', expiresAt: '2099-01-01T00:00:00Z',
    callPolicies: [{ modelId: id, model, provider: 'openrouter', protocol: 'openrouter-chat-v1',
      account: openRouterAccount('SYNTHETIC_ARGON_KEY'), inputLimit: 196608, outputLimit: 4096, upperUsd: '3',
      automaticRetry: false, hiddenTools: false, lookupSupported: true,
      providerLimits: { providerSlug: 'google-ai-studio', contextTokens: 1048576,
        promptUsdPerMillion: '2.1875', completionUsdPerMillion: '10', requestUsd: '0' } }] };
  const db = { from: (table: string) => ({ select: () => ({
    in: async (_column: string, ids: string[]) => ({ data: ids.includes(id) ? [row] : [], error: null }),
    eq: (_column: string, key: string) => ({ maybeSingle: async () => ({ error: null,
      data: table === 'system_settings' && key === 'runtime_payg_staging'
        ? { value: { version: 1, enabled: true, windowId, profiles } } : null }) }),
  }) }) } as unknown as SupabaseClient;
  return { row, profile, profiles, window, read: () => fusionModelOptions(db, id, env, window) };
}

it('lists Argon for review through real admission with an entirely synthetic quote and review-only profile', async () => {
  const f = fixture();
  expect((await f.read()).models).toEqual([{ id, name: 'Gemini 4 Argon', review: true, summary: false, compare: false }]);
});
it('keeps Argon out of the candidates until the controller supplies its exact quote and profile', async () => {
  const f = fixture();
  f.window.callPolicies = [];
  expect((await f.read()).models).toEqual([]);
  const missingProfile = fixture(); missingProfile.profiles.length = 0;
  expect((await missingProfile.read()).models).toEqual([]);
  const wrongRoute = fixture(); wrongRoute.profile.endpointTag = 'google-ai-studio/flex';
  expect((await wrongRoute.read()).models).toEqual([]);
});
