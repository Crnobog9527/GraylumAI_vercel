/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateRuntimeCandidate } from './matching';
import { BRAND_IDENTITY_INSTRUCTIONS } from '../modelIdentity/brandIdentity';

// MODEL-IDENTITY-GUARD: execute.ts activates a matched Skill through options.activateSkill, which
// executionStream.ts binds to activateRuntimeCandidate; admission sizes candidates with it too.
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
const admin = (rpc: () => unknown) => ({ rpc: async () => rpc() }) as unknown as SupabaseClient;
const guard = (enabled: boolean) => () => ({ data: { version: 1, enabled, revision: 0, updatedBy: null, updatedAt: null }, error: null });

it('a matched Skill runs with the brand identity first when the switch is on', async () => {
  expect(await activateRuntimeCandidate({} as SupabaseClient, admin(guard(true)), candidate))
    .toBe(BRAND_IDENTITY_INSTRUCTIONS + '\nMatched Skill text');
});

it('a matched Skill runs unchanged when the switch is off', async () => {
  expect(await activateRuntimeCandidate({} as SupabaseClient, admin(guard(false)), candidate)).toBe('Matched Skill text');
});

it('an unreadable switch keeps the identity on', async () => {
  const result = await activateRuntimeCandidate({} as SupabaseClient, admin(() => { throw new Error('down'); }), candidate);
  expect(result.startsWith(BRAND_IDENTITY_INSTRUCTIONS)).toBe(true);
});
