/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = vi.hoisted(() => ({ compare: {} as Record<string, unknown>, entitlements: {} as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>, error: false, notRunnable: new Set<string>(), windowFails: false }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  readFusionSettings: async () => ({ version: 1, review: {}, compare: state.compare }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()),
  readMembershipEntitlements: async () => state.entitlements }));
vi.mock('../runtime/stagingPolicy', async original => ({ ...(await original<typeof import('../runtime/stagingPolicy')>()),
  loadStagingPolicy: async () => { if (state.windowFails) throw new Error('RUNTIME_STAGING_WINDOW_UNAVAILABLE'); return { id: id(900), callPolicies: [] }; } }));
vi.mock('./settingsAdmin', () => ({
  fusionModelOptions: async () => ({ models: [id(1), id(2), id(3)].map(modelId => ({ id: modelId, name: 'n', review: true, summary: true,
    compare: !state.notRunnable.has(modelId) })) }) }));
import { compareOptions } from './compareOptions';

const admin = { from: () => ({ select: () => ({ in: async () => state.error ? { data: null, error: { code: 'x' } } : { data: state.rows, error: null } }) }) } as unknown as SupabaseClient;
beforeEach(() => {
  state.compare = { enabled: true, allowedModelIds: [id(1), id(2), id(3)], defaultModelIds: [id(1), id(2)], minModels: 2 };
  state.entitlements = { allowFusionCompare: true, fusionCompareMaxModels: 4 };
  state.rows = [{ id: id(1), name: 'Claude Sonnet 5.5', model_id: 'anthropic/claude-sonnet-5.5', is_active: 'true' },
    { id: id(2), name: 'Gemini 3.8 Flash', model_id: 'google/gemini-3.8-flash', is_active: 'true' },
    { id: id(3), name: 'GPT-6.1 Sol', model_id: 'openai/gpt-6.1-sol', is_active: 'true' }];
  state.error = false; state.notRunnable = new Set(); state.windowFails = false;
});

describe('compare picker options', () => {
  it('lists the allowed models by their real configured names, with the administrator defaults and the bounds', async () => {
    const options = await compareOptions(admin, id(50));
    expect(options).toEqual({ enabled: true, usable: true, minModels: 2, maxModels: 4, defaultModelIds: [id(1), id(2)],
      models: [{ id: id(1), name: 'Claude Sonnet 5.5' }, { id: id(2), name: 'Gemini 3.8 Flash' }, { id: id(3), name: 'GPT-6.1 Sol' }] });
  });
  it('is off, with the reason and nothing else, when the switch is off or the plan does not allow it', async () => {
    state.compare.enabled = false;
    expect(await compareOptions(admin, id(50))).toEqual({ enabled: false, reason: 'disabled' });
    state.compare.enabled = true; state.entitlements.allowFusionCompare = false;
    expect(await compareOptions(admin, id(50))).toEqual({ enabled: false, reason: 'plan' });
  });
  it('leaves out inactive models and never ticks one that is not listed; the bounds follow D3', async () => {
    state.rows[1]!.is_active = 'false';
    state.entitlements.fusionCompareMaxModels = 2;
    const options = await compareOptions(admin, id(50));
    expect(options).toMatchObject({ maxModels: 2, defaultModelIds: [id(1)] });
    expect((options as { models: Array<{ id: string }> }).models.map(model => model.id)).toEqual([id(1), id(3)]);
  });
  it('says so when there are fewer usable models than the minimum', async () => {
    state.rows = state.rows.slice(0, 1);
    expect(await compareOptions(admin, id(50))).toMatchObject({ enabled: true, usable: false });
  });
  it('never returns provider routes or internal model ids, and fails closed on a database error', async () => {
    expect(JSON.stringify(await compareOptions(admin, id(50)))).not.toMatch(/anthropic\/|google\/|openai\/|model_id/);
    state.error = true;
    await expect(compareOptions(admin, id(50))).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
  });
  it('leaves out a model that is still active but can no longer run a compare, and never ticks it by default', async () => {
    state.notRunnable.add(id(1));
    const options = await compareOptions(admin, id(50)) as { models: Array<{ id: string }>; defaultModelIds: string[]; usable: boolean };
    expect(options.models.map(model => model.id)).toEqual([id(2), id(3)]);
    expect(options.defaultModelIds).toEqual([id(2)]);
    state.notRunnable.add(id(2));
    expect(await compareOptions(admin, id(50))).toMatchObject({ usable: false });
  });
  it('fails closed when the live window cannot be read', async () => {
    state.windowFails = true;
    await expect(compareOptions(admin, id(50))).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
  });
});

import { compareModelNames } from './compareOptions';
describe('compare card model names', () => {
  it('names exactly the models a conversation used, even ones no longer on the allowlist or switched off', async () => {
    state.compare = { enabled: false, allowedModelIds: [], defaultModelIds: [], minModels: 2 };
    state.rows = [{ id: id(1), name: 'Claude Sonnet 5.5', model_id: 'anthropic/claude-sonnet-5.5', is_active: 'false' }];
    expect(await compareModelNames(admin, [id(1), id(1)])).toEqual({ [id(1)]: 'Claude Sonnet 5.5' });
    expect(await compareModelNames(admin, [])).toEqual({});
  });
  it('reports an unreadable model list as unavailable, never a partial map', async () => {
    state.error = true;
    await expect(compareModelNames(admin, [id(1)])).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
  });
});
