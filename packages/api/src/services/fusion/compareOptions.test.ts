/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = vi.hoisted(() => ({ compare: {} as Record<string, unknown>, entitlements: {} as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>, error: false }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  readFusionSettings: async () => ({ version: 1, review: {}, compare: state.compare }) }));
vi.mock('../membershipEntitlements', async original => ({ ...(await original<typeof import('../membershipEntitlements')>()),
  readMembershipEntitlements: async () => state.entitlements }));
import { compareOptions } from './compareOptions';

const admin = { from: () => ({ select: () => ({ in: async () => state.error ? { data: null, error: { code: 'x' } } : { data: state.rows, error: null } }) }) } as unknown as SupabaseClient;
beforeEach(() => {
  state.compare = { enabled: true, allowedModelIds: [id(1), id(2), id(3)], defaultModelIds: [id(1), id(2)], minModels: 2 };
  state.entitlements = { allowFusionCompare: true, fusionCompareMaxModels: 4 };
  state.rows = [{ id: id(1), name: 'Claude Sonnet 5.5', model_id: 'anthropic/claude-sonnet-5.5', is_active: 'true' },
    { id: id(2), name: 'Gemini 3.8 Flash', model_id: 'google/gemini-3.8-flash', is_active: 'true' },
    { id: id(3), name: 'GPT-6.1 Sol', model_id: 'openai/gpt-6.1-sol', is_active: 'true' }];
  state.error = false;
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
});
