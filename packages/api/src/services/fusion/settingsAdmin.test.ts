/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_FUSION_SETTINGS } from './settings';

const skill = vi.hoisted(() => ({ available: true, writes: 0, refuse: new Map<string, string>(),
  keyReads: [] as Array<{ fresh: boolean }>, admitKeys: [] as unknown[], limits: new Map<string, number>() }));
// ADMIN-SECRETS OR-1: the platform OpenRouter key is read once per listing or save and shared by every per-model check.
vi.mock('../models/openRouterKey', () => {
  const read = async (_db: unknown, options?: { fresh?: boolean }) => { skill.keyReads.push({ fresh: options?.fresh === true }); return 'SYNTHETIC_KEY'; };
  return { readOpenRouterKey: read, readOpenRouterKeyOrUnset: read };
});
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
    return { outputLimit: skill.limits.get(`${row.id}:${phase}`) ?? _t };
  } }));
vi.mock('../turn/settings/stagingPolicy', () => ({ parseStagingPolicy: () => ({ expiresAt: '2030-01-01T00:00:00Z' }) }));
vi.mock('../turn/settings/stagingEnvironment', () => ({ stagingRuntimeWindow: () => id(9) }));
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
    expect(skill.admitKeys).toHaveLength(15); // 5 models × (review, summary, compare)
    expect(skill.admitKeys.every(key => key === 'SYNTHETIC_KEY')).toBe(true);
  });
});

describe('Fusion model choices', () => {
  it('does not offer a model for compare when its own limit would shorten the answer (a save of it would be refused)', async () => {
    skill.refuse = new Map(); skill.limits = new Map([[`${id(1)}:fusion_compare`, 1024]]);
    const window = { callPolicies: models.map(model => ({ modelId: model.id })), expiresAt: '2030-01-01T00:00:00Z' };
    const result = await fusionModelOptions(db, id(7), {}, window as never);
    expect(result.models.find(model => model.id === id(1))).toMatchObject({ review: true, summary: true, compare: false });
    expect(result.models.find(model => model.id === id(2))).toMatchObject({ compare: true });
    skill.limits = new Map();
  });
  it('lists the window\'s models with what each may do, by the same Fusion admission a save uses', async () => {
    skill.refuse = new Map([[`${id(2)}:fusion_summary`, 'FUSION_PAYG_REQUIRED'], [`${id(3)}:fusion_review`, 'FUSION_MODEL_SEARCH_DENIED'],
      [`${id(3)}:fusion_summary`, 'FUSION_MODEL_SEARCH_DENIED'], [`${id(4)}:fusion_review`, 'FUSION_MODEL_ADMISSION_REQUIRED'],
      // An ordinary-only model (no Fusion profile entry) is left out; it never blanks the list (#1044 review).
      [`${id(5)}:fusion_review`, 'RUNTIME_PAYG_PROFILE_REQUIRED'], [`${id(5)}:fusion_summary`, 'RUNTIME_PAYG_PROFILE_REQUIRED'],
      [`${id(5)}:fusion_compare`, 'RUNTIME_PAYG_PROFILE_REQUIRED'], [`${id(3)}:fusion_compare`, 'FUSION_MODEL_SEARCH_DENIED'],
      [`${id(2)}:fusion_compare`, 'FUSION_PAYG_REQUIRED']]);
    const window = { callPolicies: models.map(model => ({ modelId: model.id })), expiresAt: '2030-01-01T00:00:00Z' };
    const result = await fusionModelOptions(db, id(7), {}, window as never);
    expect(result.models).toEqual([
      { id: id(1), name: '模型 1', review: true, summary: true, compare: true },
      { id: id(2), name: '模型 2', review: true, summary: false, compare: false },
      { id: id(4), name: '模型 4', review: false, summary: true, compare: true },
    ]);
    // An unexpected failure is an outage, never an empty or partial list.
    skill.refuse = new Map([[`${id(1)}:fusion_review`, 'database exploded']]);
    await expect(fusionModelOptions(db, id(7), {}, window as never)).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
    skill.refuse = new Map();
  });
});

describe('Fusion model choices for the compare picker', () => {
  const window = { callPolicies: models.map(model => ({ modelId: model.id })), expiresAt: '2030-01-01T00:00:00Z' };
  it('checks the compare purpose alone: one admission per model, not three', async () => {
    skill.refuse = new Map([[`${id(2)}:fusion_compare`, 'FUSION_PAYG_REQUIRED']]); skill.admitKeys = [];
    const result = await fusionModelOptions(db, id(7), {}, window as never, { only: 'compare' });
    expect(skill.admitKeys).toHaveLength(5);
    // The same models in the same order as the full check gives for compare; the other two purposes are not answered.
    expect(result.models).toEqual([id(1), id(3), id(4), id(5)].map(modelId => (
      { id: modelId, name: `模型 ${Number(modelId.slice(-2))}`, review: false, summary: false, compare: true })));
    const full = await fusionModelOptions(db, id(7), {}, window as never);
    expect(full.models.filter(model => model.compare).map(model => model.id)).toEqual(result.models.map(model => model.id));
    skill.refuse = new Map();
  });
  it('is not failed by a purpose it does not use, and still fails closed on an outage of the compare check', async () => {
    skill.refuse = new Map([[`${id(1)}:fusion_review`, 'database exploded']]);
    await expect(fusionModelOptions(db, id(7), {}, window as never, { only: 'compare' })).resolves.toMatchObject({ models: expect.any(Array) });
    skill.refuse = new Map([[`${id(4)}:fusion_compare`, 'database exploded']]);
    await expect(fusionModelOptions(db, id(7), {}, window as never, { only: 'compare' })).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
    skill.refuse = new Map();
  });
  it('uses the settings its caller already read', async () => {
    skill.limits = new Map(); skill.refuse = new Map();
    const settings = { ...DEFAULT_FUSION_SETTINGS, compare: { ...DEFAULT_FUSION_SETTINGS.compare, answerOutputTokens: 777 } };
    // A model clamped to another limit is not offered: the limit compared is the caller's, not a second read's.
    skill.limits = new Map(models.map(model => [`${model.id}:fusion_compare`, model.id === id(2) ? 777 : 4096]));
    const result = await fusionModelOptions(db, id(7), {}, window as never, { only: 'compare', settings });
    expect(result.models.map(model => model.id)).toEqual([id(2)]);
    skill.limits = new Map();
  });
});

describe('Fusion compare save (FUSION-COMPARE §3.3)', () => {
  const compareOn = { ...enabled, review: DEFAULT_FUSION_SETTINGS.review, compare: { ...DEFAULT_FUSION_SETTINGS.compare, enabled: true,
    allowedModelIds: [id(1), id(2), id(3)], defaultModelIds: [id(1), id(2)], minModels: 2, maxBudgetUsd: '2' } };
  it('admits every allowed model for compare when enabling, and refuses the save if one fails', async () => {
    skill.refuse = new Map(); skill.writes = 0; skill.admitKeys = [];
    await expect(saveFusionSettings(db, id(7), compareOn)).resolves.toMatchObject({ warnings: [] });
    expect(skill.writes).toBe(1);
    expect(skill.admitKeys).toHaveLength(3);
    skill.refuse = new Map([[`${id(2)}:fusion_compare`, 'RUNTIME_PAYG_PROFILE_REQUIRED']]);
    await expect(saveFusionSettings(db, id(7), compareOn)).rejects.toThrow('RUNTIME_PAYG_PROFILE_REQUIRED');
    expect(skill.writes).toBe(1);
    skill.refuse = new Map();
  });
  it('refuses a model that would have to answer shorter than the shared limit, so no column ever differs from another', async () => {
    skill.refuse = new Map(); skill.limits = new Map([[`${id(3)}:fusion_compare`, 2048]]); skill.writes = 0;
    await expect(saveFusionSettings(db, id(7), compareOn)).rejects.toThrow('FUSION_COMPARE_OUTPUT_LIMIT');
    expect(skill.writes).toBe(0);
    skill.limits = new Map();
  });
  it('saves a disabled compare without admitting its models, but still refuses a built-in search model', async () => {
    skill.admitKeys = []; skill.writes = 0;
    await saveFusionSettings(db, id(7), { ...compareOn, compare: { ...compareOn.compare, enabled: false } });
    expect(skill.admitKeys).toHaveLength(0);
    expect(skill.writes).toBe(1);
  });
  it('holds the minimum and the default ticks to the stored D3', async () => {
    skill.writes = 0;
    const withD3 = (value: unknown) => ({ ...db, from: (table: string) => table === 'system_settings'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value }, error: null }) }) }) } : db.from(table) }) as unknown as SupabaseClient;
    const three = { ...compareOn, compare: { ...compareOn.compare, minModels: 3, defaultModelIds: [id(1), id(2), id(3)] } };
    await expect(saveFusionSettings(withD3(2), id(7), three)).rejects.toThrow('FUSION_COMPARE_LIMIT_EXCEEDED'); // min 3 > D3 2
    await expect(saveFusionSettings(withD3(2), id(7), { ...compareOn, compare: { ...compareOn.compare,
      defaultModelIds: [id(1), id(2), id(3)] } })).rejects.toThrow('FUSION_COMPARE_LIMIT_EXCEEDED'); // 3 default ticks > D3 2
    expect(skill.writes).toBe(0);
    await expect(saveFusionSettings(withD3(2), id(7), compareOn)).resolves.toBeDefined(); // 2 ticks and min 2 fit D3 = 2
    expect(skill.writes).toBe(1);
  });
});

