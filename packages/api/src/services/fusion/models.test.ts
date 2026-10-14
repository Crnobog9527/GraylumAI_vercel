/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitFusionModel, type FusionModelRow } from './models';
import type { StagingPolicy } from '../runtime/stagingPolicy';

const key = 'SYNTHETIC_LOCAL_ONLY';
const row: FusionModelRow = { id: '00000000-0000-4000-8000-000000000001', name: 'Synthetic', model_id: 'anthropic/claude-sonnet-5.5',
  provider: 'openrouter', is_active: 'true', input_limit: 250000, max_tokens: 8192, config: null, api_key: key, api_endpoint: 'https://openrouter.ai/api/v1' };
const providerLimits = { providerSlug: 'anthropic', contextTokens: 250000, promptUsdPerMillion: '1', completionUsdPerMillion: '1', requestUsd: '0' };
const window = { id: '00000000-0000-4000-8000-000000000009', creditsPerUsd: '100', multiplier: '3', expiresAt: new Date(Date.now() + 3600000).toISOString(),
  callPolicies: [{ modelId: row.id, model: row.model_id, provider: 'openrouter', protocol: 'openrouter-chat-v1', providerLimits,
    account: 'openrouter-key:' + createHash('sha256').update(key).digest('hex'), upperUsd: '1', inputLimit: 196608, outputLimit: 8192,
    automaticRetry: false, hiddenTools: false, lookupSupported: true, multiplier: '3' }] } as unknown as StagingPolicy;
const db = {} as SupabaseClient;
const admit = (patch: Partial<FusionModelRow>, w = window) =>
  admitFusionModel(db, w, { ...row, ...patch }, 'fusion_review', 4096, new Date().toISOString());

describe('Fusion model admission refuses models that could never be dispatched', () => {
  it('refuses a blank key, a non-OpenRouter endpoint and an inactive model before any hold', async () => {
    await expect(admit({ api_key: '  ' })).rejects.toThrow('FUSION_MODEL_UNAVAILABLE');
    await expect(admit({ api_endpoint: 'https://api.example.test/v1' })).rejects.toThrow('FUSION_MODEL_UNAVAILABLE');
    await expect(admit({ is_active: 'false' })).rejects.toThrow('FUSION_MODEL_UNAVAILABLE');
  });
  it('refuses a key that is not the one the window quote is bound to', async () => {
    await expect(admit({ api_key: 'ANOTHER_SYNTHETIC_KEY' })).rejects.toThrow('FUSION_MODEL_ADMISSION_REQUIRED');
  });
  it('refuses built-in search models', async () => {
    await expect(admit({ model_id: 'perplexity/sonar' })).rejects.toThrow('FUSION_MODEL_SEARCH_DENIED');
  });
});
