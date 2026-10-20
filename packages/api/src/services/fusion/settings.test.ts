/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_FUSION_SETTINGS, fusionSettings, readFusionSettings } from './settings';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const enabled = { ...DEFAULT_FUSION_SETTINGS, review: { ...DEFAULT_FUSION_SETTINGS.review, enabled: true,
  reviewerModelIds: [id(1), id(2), id(3)], summaryModelId: id(4), maxBudgetUsd: '3', skillId: id(5) } };
const db = (value: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({
  maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) }) }) }) }) as unknown as SupabaseClient;

describe('Fusion settings', () => {
  it('defaults to both modes off, 3 reviewers + 1 summary, one round by default', async () => {
    expect(await readFusionSettings(db(undefined))).toEqual(DEFAULT_FUSION_SETTINGS);
    expect(DEFAULT_FUSION_SETTINGS.review).toMatchObject({ enabled: false, maxRounds: 1, dispatchMinutes: 10, maxBudgetUsd: null });
    expect(DEFAULT_FUSION_SETTINGS.compare.enabled).toBe(false);
  });
  it('fixed price per review: 1500 credits by default, also for a stored row saved before the field existed (0294)', async () => {
    expect(DEFAULT_FUSION_SETTINGS.review.fixedPriceCredits).toBe(1500);
    const older: Partial<typeof enabled.review> = { ...enabled.review };
    delete older.fixedPriceCredits;
    expect((await readFusionSettings(db({ ...enabled, review: older }))).review.fixedPriceCredits).toBe(1500);
    for (const fixedPriceCredits of [0, 1.5, 1_000_000])
      expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, fixedPriceCredits } }).success).toBe(false);
    expect(fusionSettings.parse({ ...enabled, review: { ...enabled.review, fixedPriceCredits: 1200 } }).review.fixedPriceCredits).toBe(1200);
  });
  it('reads a stored object or JSON string; refuses invalid or unreadable values', async () => {
    expect(await readFusionSettings(db(enabled))).toEqual(enabled);
    expect(await readFusionSettings(db(JSON.stringify(enabled)))).toEqual(enabled);
    await expect(readFusionSettings(db({ version: 1 }))).rejects.toThrow('FUSION_SETTINGS_INVALID');
    await expect(readFusionSettings(db('{'))).rejects.toThrow('FUSION_SETTINGS_INVALID');
    await expect(readFusionSettings(db(undefined, { code: 'x' }))).rejects.toThrow('FUSION_SETTINGS_UNAVAILABLE');
  });
  it('requires 3–8 reviewers, a summary model and a budget to enable review', () => {
    expect(fusionSettings.safeParse(enabled).success).toBe(true);
    for (const review of [{ reviewerModelIds: [id(1), id(2)] }, { summaryModelId: null }, { maxBudgetUsd: null }])
      expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, ...review } }).success).toBe(false);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, reviewerModelIds: [id(1), id(1), id(2)] } }).success).toBe(false);
  });
  it('refuses to enable review without a review Skill', () => {
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, skillId: null } }).success).toBe(false);
  });

  it('has exactly three seats when enabled, at most a debate round, and panel names apart from the models', () => {
    const four = Array.from({ length: 4 }, (_, i) => id(i + 10));
    const two = four.slice(0, 2);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, reviewerModelIds: four } }).success).toBe(false);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, reviewerModelIds: two } }).success).toBe(false);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, maxRounds: 3 } }).success).toBe(false);
    const parsed = fusionSettings.parse(enabled);
    expect(parsed.review.displayNames).toEqual({ reviewers: ['评审 A', '评审 B', '评审 C'], summary: '汇总' });
    const named = fusionSettings.parse({ ...enabled, review: { ...enabled.review,
      displayNames: { reviewers: ['  受众代表\u0007 ', '操盘手', '挑刺官'], summary: '主持人' } } });
    expect(named.review.displayNames.reviewers[0]).toBe('受众代表');
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review,
      displayNames: { reviewers: ['一'.repeat(21), 'B', 'C'], summary: 'S' } } }).success).toBe(false);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review,
      displayNames: { reviewers: ['   ', 'B', 'C'], summary: 'S' } } }).success).toBe(false);
  });
});

describe('Fusion compare settings (FUSION-COMPARE §3.3)', () => {
  const on = { ...DEFAULT_FUSION_SETTINGS, compare: { ...DEFAULT_FUSION_SETTINGS.compare, enabled: true,
    allowedModelIds: [id(1), id(2), id(3)], defaultModelIds: [id(1), id(2)], minModels: 2, maxBudgetUsd: '2' } };
  it('reads a row stored before this task (only `enabled`) with every other field at its default, off and unusable', async () => {
    const old = { version: 1, review: DEFAULT_FUSION_SETTINGS.review, compare: { enabled: false } };
    const read = await readFusionSettings(db(old));
    expect(read.compare).toEqual(DEFAULT_FUSION_SETTINGS.compare);
    expect(read.compare).toMatchObject({ minModels: 2, allowedModelIds: [], defaultModelIds: [], maxBudgetUsd: null });
    // An old row that says enabled has no models or budget: refused, never half-configured.
    await expect(readFusionSettings(db({ ...old, compare: { enabled: true } }))).rejects.toThrow('FUSION_SETTINGS_INVALID');
  });
  it('accepts a complete configuration and requires enough models, default ticks and a budget to enable', () => {
    expect(fusionSettings.safeParse(on).success).toBe(true);
    for (const compare of [{ allowedModelIds: [id(1)], defaultModelIds: [id(1)] }, { defaultModelIds: [id(1)] }, { maxBudgetUsd: null },
      { minModels: 3 }])
      expect(fusionSettings.safeParse({ ...on, compare: { ...on.compare, ...compare } }).success).toBe(false);
  });
  it('keeps the default ticks inside the allowlist, without duplicates, and the minimum at 2 or more', () => {
    for (const compare of [{ defaultModelIds: [id(1), id(9)] }, { defaultModelIds: [id(1), id(1)] }, { allowedModelIds: [id(1), id(1), id(2)] },
      { minModels: 1 }, { minModels: 9 }])
      expect(fusionSettings.safeParse({ ...on, compare: { ...on.compare, ...compare } }).success).toBe(false);
    // Disabled keeps its structure rules but needs no models.
    expect(fusionSettings.safeParse({ ...on, compare: { ...on.compare, enabled: false, allowedModelIds: [], defaultModelIds: [] } }).success).toBe(true);
    expect(fusionSettings.safeParse({ ...on, compare: { ...on.compare, answerOutputTokens: 100 } }).success).toBe(false);
  });
  it('seat angles: all or none, one each, bound to the reviewers actually configured', () => {
    const ids = enabled.review.reviewerModelIds;
    const roles = { [ids[0]!]: 'finance', [ids[1]!]: 'evidence', [ids[2]!]: 'execution' };
    expect(fusionSettings.parse({ ...enabled, review: { ...enabled.review, reviewerRoles: roles } }).review.reviewerRoles).toEqual(roles);
    expect(fusionSettings.parse(enabled).review.reviewerRoles).toEqual({});
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, reviewerRoles: { [ids[0]!]: 'finance' } } }).success).toBe(false);
    expect(fusionSettings.safeParse({ ...enabled, review: { ...enabled.review, reviewerRoles: { ...roles, [ids[2]!]: 'finance' } } }).success).toBe(false);
  });
});

