/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_FUSION_SETTINGS, fusionSettings, readFusionSettings } from './settings';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const enabled = { ...DEFAULT_FUSION_SETTINGS, review: { ...DEFAULT_FUSION_SETTINGS.review, enabled: true,
  reviewerModelIds: [id(1), id(2), id(3)], summaryModelId: id(4), maxBudgetUsd: '3' } };
const db = (value: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({
  maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) }) }) }) }) as unknown as SupabaseClient;

describe('Fusion settings', () => {
  it('defaults to both modes off, 3 reviewers + 1 summary, at most 2 rounds', async () => {
    expect(await readFusionSettings(db(undefined))).toEqual(DEFAULT_FUSION_SETTINGS);
    expect(DEFAULT_FUSION_SETTINGS.review).toMatchObject({ enabled: false, maxRounds: 2, dispatchMinutes: 10, maxBudgetUsd: null });
    expect(DEFAULT_FUSION_SETTINGS.compare.enabled).toBe(false);
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
