/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_FUSION_SETTINGS } from './settings';

const skill = vi.hoisted(() => ({ available: true, writes: 0 }));
vi.mock('./reviewPrompts', async original => ({ ...(await original<typeof import('./reviewPrompts')>()),
  resolveReviewSkill: async () => {
    if (!skill.available) throw new Error('FUSION_REVIEW_SKILL_UNAVAILABLE');
    return { skillId: id(5), revisionId: id(6), packageHash: 'a'.repeat(64) };
  },
  readReviewSkill: async () => ({ reviewer: 'r', summary: 's', rubric: 'b' }) }));
vi.mock('./models', async original => ({ ...(await original<typeof import('./models')>()), admitFusionModel: async () => ({}) }));
vi.mock('../runtime/stagingPolicy', () => ({ parseStagingPolicy: () => ({ expiresAt: '2030-01-01T00:00:00Z' }) }));
vi.mock('../runtime/stagingEnvironment', () => ({ stagingRuntimeWindow: () => id(9) }));
vi.mock('./settings', async original => ({ ...(await original<typeof import('./settings')>()),
  writeFusionSettings: async (_db: unknown, value: unknown) => { skill.writes++; return value; } }));
import { saveFusionSettings } from './settingsAdmin';

function id(n: number) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
const enabled = { ...DEFAULT_FUSION_SETTINGS, review: { ...DEFAULT_FUSION_SETTINGS.review, enabled: true,
  reviewerModelIds: [id(1), id(2), id(3)], summaryModelId: id(4), maxBudgetUsd: '3', skillId: id(5) } };
const models = ['anthropic/a', 'google/b', 'openai/c', 'openai/d'].map((model_id, i) => ({ id: id(i + 1), model_id }));
const db = { from: () => ({ select: () => ({ in: async () => ({ data: models, error: null }) }) }),
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
