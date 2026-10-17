/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_FUSION_SETTINGS } from './settings';

const skill = vi.hoisted(() => ({ available: true, writes: 0, refuse: new Map<string, string>(),
  keyReads: [] as Array<{ fresh: boolean }>, admitKeys: [] as unknown[] }));
// ADMIN-SECRETS OR-1: the platform OpenRouter key is read once per listing or save and shared by every per-model check.
vi.mock('../models/openRouterKey', () => ({
  readOpenRouterKey: async (_db: unknown, options?: { fresh?: boolean }) => { skill.keyReads.push({ fresh: options?.fresh === true }); return 'SYNTHETIC_KEY'; },
}));
vi.mock('./reviewPrompts', async original => ({ ...(await original<typeof import('./reviewPrompts')>()),
  resolveReviewSkill: async () => {
    if (!skill.available) throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
    return { skillId: id(5), revisionId: id(6), packageHash: 'a'.repeat(64) };
  },
  readReviewSkill: async () => ({ reviewer: 'r', summary: 's', rubric: 'b' }) }));
vi.mock('./models', async original => ({ ...(await original<typeof import('./models')>()),
  // A model refused for one purpose: key "<id>:<phase>" → the refusal (an Error with that message).
  admitFusionModel: async (_db: unknown, _window: unknown, row: { id: string }, phase: string, _t: unknown, _d: unknown, _e: unknown,
    knownKey?: string | null) => {
    skill.admitKeys.push(knownKey);
    const code = skill.refuse.get(`${row.id}:${phase}`);
    if (code) throw new Error(code);
    return {};
  } }));
vi.mock('../runtime/stagingPolicy', () => ({ parseStagingPolicy: () => ({ expiresAt: '2030-01-01T00:00:00Z' }) }));
vi.mock('../runtime/stagingEnvironment', () => ({ stagingRuntimeWindow: () => id(9) }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  writeFusionSettings: async (_db: unknown, value: unknown) => { skill.writes++; return value; } }));
import { fusionModelOptions, saveFusionSettings } from './settingsAdmin';

function id(n: number) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
const enabled = { ...DEFAULT_FUSION_SETTINGS, review: { ...DEFAULT_FUSION_SETTINGS.review, enabled: true,
  reviewerModelIds: [id(1), id(2), id(3)], summaryModelId: id(4), maxBudgetUsd: '3', skillId: id(5) } };
const models = ['anthropic/a', 'google/b', 'openai/c', 'openai/d', 'openai/e'].map((model_id, i) => ({ id: id(i + 1), model_id,
  name: `模型 ${i + 1}` }));
const db = { from: () => ({ select: () => ({ in: async () => ({ data: models, error: null }),
  eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  rpc: async () => ({ data: {}, error: null }) } as unknown as SupabaseClient;

describe('Fusion settings save', () => {
  it('refuses to enable reviews with a Skill that is not published with a readable package', async () => {
    skill.available = false; skill.writes = 0;
    await expect(saveFusionSettings(db, id(7), enabled)).rejects.toThrow('FUSION_REVIEW_SKILL_UNAVAILABLE');
    expect(skill.writes).toBe(0);
    skill.available = true;
    await expect(saveFusionSettings(db, id(7), enabled)).resolves.toMatchObject({ warnings: [] });
    expect(skill.writes).toBe(1);
  });
});

describe('Fusion key reads', () => {
  it('a save reads the key once, fresh, for all its checks; the read-only listing reads once from the cache', async () => {
    skill.refuse = new Map(); skill.keyReads = []; skill.admitKeys = [];
    await saveFusionSettings(db, id(7), enabled);
    expect(skill.keyReads).toEqual([{ fresh: true }]);
    expect(skill.admitKeys).toHaveLength(4);
    expect(skill.admitKeys.every(key => key === 'SYNTHETIC_KEY')).toBe(true);
    skill.keyReads = []; skill.admitKeys = [];
    const window = { callPolicies: models.map(model => ({ modelId: model.id })), expiresAt: '2030-01-01T00:00:00Z' };
    await fusionModelOptions(db, id(7), {}, window as never);
    expect(skill.keyReads).toEqual([{ fresh: false }]); // 5 models × 2 purposes, one read
    expect(skill.admitKeys).toHaveLength(10);
    expect(skill.admitKeys.every(key => key === 'SYNTHETIC_KEY')).toBe(true);
  });
});

describe('Fusion model choices', () => {
  it('lists the window\'s models with what each may do, by the same Fusion admission a save uses', async () => {
    skill.refuse = new Map([[`${id(2)}:fusion_summary`, 'FUSION_PAYG_REQUIRED'], [`${id(3)}:fusion_review`, 'FUSION_MODEL_SEARCH_DENIED'],
      [`${id(3)}:fusion_summary`, 'FUSION_MODEL_SEARCH_DENIED'], [`${id(4)}:fusion_review`, 'FUSION_MODEL_ADMISSION_REQUIRED'],
      // An ordinary-only model (no Fusion profile entry) is left out; it never blanks the list (#1044 review).
      [`${id(5)}:fusion_review`, 'RUNTIME_PAYG_PROFILE_REQUIRED'], [`${id(5)}:fusion_summary`, 'RUNTIME_PAYG_PROFILE_REQUIRED']]);
    const window = { callPolicies: models.map(model => ({ modelId: model.id })), expiresAt: '2030-01-01T00:00:00Z' };
    const result = await fusionModelOptions(db, id(7), {}, window as never);
    expect(result.models).toEqual([
      { id: id(1), name: '模型 1', review: true, summary: true },
      { id: id(2), name: '模型 2', review: true, summary: false },
      { id: id(4), name: '模型 4', review: false, summary: true },
    ]);
    // An unexpected failure is an outage, never an empty or partial list.
    skill.refuse = new Map([[`${id(1)}:fusion_review`, 'database exploded']]);
    await expect(fusionModelOptions(db, id(7), {}, window as never)).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
    skill.refuse = new Map();
  });
});
