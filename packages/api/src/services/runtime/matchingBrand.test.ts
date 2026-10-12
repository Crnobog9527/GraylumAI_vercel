/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateRuntimeCandidate } from './matching';
import { BRAND_IDENTITY_INSTRUCTIONS, frozenBrandIdentity, withBrandIdentity } from '../modelIdentity/brandIdentity';

// MODEL-IDENTITY-GUARD: admission sizes candidates with activateRuntimeCandidate(…, frozen flag);
// execute.ts wraps options.activateSkill with the flag frozen into the admitted instructions.
vi.mock('../skills/databaseSource', () => ({ databaseSkillSource: () => ({}) }));
vi.mock('../skills/loader', async original => ({
  ...await original<typeof import('../skills/loader')>(),
  activateSkill: async () => ({ forModel: () => 'Matched Skill text' }),
}));
const candidate = {
  key: 'candidate-0', name: 'Skill', description: 'd', moduleId: '10000000-0000-4000-8000-000000000001',
  skillId: '10000000-0000-4000-8000-000000000002', packageId: 'pkg', revisionId: '10000000-0000-4000-8000-000000000003',
  packageHash: 'a'.repeat(64), modelId: '10000000-0000-4000-8000-000000000004', model: 'fixture',
  inputLimit: 32000, outputLimit: 100, requiresTask: false,
};
const admin = {} as SupabaseClient;

it('a matched Skill runs with the brand identity first when it was frozen on at admission', async () => {
  expect(await activateRuntimeCandidate({} as SupabaseClient, admin, candidate, true))
    .toBe(BRAND_IDENTITY_INSTRUCTIONS + '\nMatched Skill text');
});

it('a matched Skill runs unchanged when the switch was off (and by default for old callers)', async () => {
  expect(await activateRuntimeCandidate({} as SupabaseClient, admin, candidate, false)).toBe('Matched Skill text');
  expect(await activateRuntimeCandidate({} as SupabaseClient, admin, candidate)).toBe('Matched Skill text');
});

it('the executor derives the frozen decision from the admitted instructions without another read', () => {
  expect(frozenBrandIdentity(withBrandIdentity('Answer', true))).toBe(true);
  expect(frozenBrandIdentity('Answer')).toBe(false);
  expect(frozenBrandIdentity(BRAND_IDENTITY_INSTRUCTIONS)).toBe(false);
});
