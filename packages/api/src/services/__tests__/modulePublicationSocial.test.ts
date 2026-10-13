/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { saveModuleSkill, type ModuleSkillInput } from '../skills/modulePublication';
import { makePackage } from './fixtures/artifacts';

function moduleInput(): ModuleSkillInput {
  const pack = makePackage();
  return { moduleId: randomUUID(), skillId: pack.id, revisionId: pack.revisionId, requestId: pack.requestId,
    expectedUpdatedAt: null, expectedVersion: 0, directoryName: 'synthetic-method', kind: 'document', socialMediaRelated: false,
    files: pack.files, steps: [{ title: '需求', resources: ['references/step-0.md'] }, { title: '成果', resources: ['SKILL.md'] }],
    resourcePlanReviewed: true, module: { title: 'Synthetic private method', description: null, full_description: null,
      model_id: randomUUID(), platform: 'all', category: 'analysis', icon: 'Wand2', image_url: null,
      badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
      features: null, examples: null, preparation_questions: null } };
}

// POSITIONING-GATE PR2: a new Skill gets its "与社交媒体相关" choice at first publication.
const reasoning = { reasoning: { route: 'deepinfra', purposes: { interactive: { mode: 'off', wire: 'reasoning_effort' } }, catalog: {
  fetchedAt: '2026-09-29T00:00:00.000Z', model: 'qwen/qwen3.8-27b',
  reasoning: { mandatory: false, defaultEnabled: true, supportedEfforts: ['low'], defaultEffort: 'low', supportsMaxTokens: false },
  endpoints: [{ tag: 'deepinfra', providerName: 'DeepInfra', supportedParameters: ['tools', 'reasoning_effort'],
    contextLength: 10000, maxCompletionTokens: 4096 }] } } };

type Step = { table: string; op: 'select' | 'update'; values?: unknown; filters: Array<[string, unknown]> };
function database(options: { flagFails?: boolean; enableFails?: boolean; flagged?: boolean; skillBound?: boolean } = {}) {
  const steps: Step[] = [];
  let version = '2026-10-13T00:00:00.000Z', flagged = options.flagged ?? false;
  const from = (table: string) => {
    const step: Step = { table, op: 'select', filters: [] };
    steps.push(step);
    const chain = {
      select: () => chain,
      update: (values: unknown) => { step.op = 'update'; step.values = values; return chain; },
      eq: (column: string, value: unknown) => { step.filters.push([column, value]); return chain; },
      single: async () => ({ data: { id: randomUUID(), name: 'Qwen', model_id: 'qwen/qwen3.8-27b', provider: 'openai', is_active: 'true',
        max_tokens: 4096, input_limit: 800000, api_key: 'LOCAL_ONLY', api_endpoint: '', config: reasoning }, error: null }),
      maybeSingle: async () => ({ data: { id: 'm', social_media_related: flagged, updated_at: version,
        skill_id: options.skillBound ? 'bound-skill' : null }, error: null }),
      then: (resolve: (value: unknown) => void) => {
        const values = step.values as { social_media_related?: boolean; active?: boolean } | undefined;
        if (values?.social_media_related !== undefined) {
          if (options.flagFails) return resolve({ data: [], error: null });
          flagged = values.social_media_related; version = '2026-10-13T00:00:01.000Z';
          return resolve({ data: [{ id: 'm', social_media_related: flagged, updated_at: version }], error: null });
        }
        if (values?.active) return resolve({ data: options.enableFails ? [] : [{ id: 'm' }], error: null });
        return resolve({ data: null, error: null });
      },
    };
    return chain;
  };
  const rpc = vi.fn().mockResolvedValue({ data: { moduleId: 'm', revisionId: 'r', version: 1 }, error: null });
  return { db: { from, rpc } as never, rpc, steps, updates: () => steps.filter(step => step.op === 'update') };
}
const metadata = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls[0]![1].p_metadata as { active: boolean };
function positioningInput(): ModuleSkillInput {
  const input = moduleInput();
  input.steps = input.steps.map((step, i) => ({ ...step, information: [{ id: 'f' + i, title: '字段' + i, required: true, profileKey: 'k' + i }] }));
  return input;
}

it('requires the choice for a new module before any write', async () => {
  const f = database(), input = moduleInput();
  delete input.socialMediaRelated;
  await expect(saveModuleSkill(f.db, randomUUID(), input)).rejects.toThrow(/^SOCIAL_MEDIA_FLAG_REQUIRED$/);
  expect(f.rpc).not.toHaveBeenCalled();
});

it('publishes an unflagged new module exactly as requested', async () => {
  const f = database(), input = moduleInput();
  await saveModuleSkill(f.db, randomUUID(), input);
  expect(metadata(f.rpc)).toEqual(input.module);
  expect(f.updates()).toEqual([]);
});

it('creates a flagged new module disabled, flags it, then enables it only while still flagged', async () => {
  const f = database(), input = { ...moduleInput(), socialMediaRelated: true };
  await saveModuleSkill(f.db, randomUUID(), input);
  expect(metadata(f.rpc)).toEqual({ ...input.module, active: false });
  const [flag, enable] = f.updates();
  expect(flag!.values).toMatchObject({ social_media_related: true });
  expect(flag!.filters).toEqual(expect.arrayContaining([['social_media_related', false], ['updated_at', '2026-10-13T00:00:00.000Z']]));
  expect(enable!.values).toMatchObject({ active: true });
  expect(enable!.filters).toEqual(expect.arrayContaining([['social_media_related', true], ['updated_at', '2026-10-13T00:00:01.000Z']]));
});

it('keeps a flagged new module disabled when it was requested disabled', async () => {
  const f = database(), input = { ...moduleInput(), socialMediaRelated: true };
  input.module = { ...input.module, active: false };
  await saveModuleSkill(f.db, randomUUID(), input);
  expect(f.updates().map(step => step.values)).toEqual([expect.objectContaining({ social_media_related: true })]);
});

it.each(['flagFails', 'enableFails'] as const)('leaves the module disabled and reports it when %s', async failure => {
  const f = database({ [failure]: true }), input = { ...moduleInput(), socialMediaRelated: true };
  await expect(saveModuleSkill(f.db, randomUUID(), input)).rejects.toThrow(/^SOCIAL_MEDIA_FLAG_NEW_MODULE_INCOMPLETE$/);
  expect(metadata(f.rpc).active).toBe(false);
  if (failure === 'flagFails') expect(f.updates().some(step => (step.values as { active?: boolean }).active)).toBe(false);
});

it('refuses flagging a new positioning Skill before publishing', async () => {
  const f = database(), input = { ...positioningInput(), socialMediaRelated: true };
  await expect(saveModuleSkill(f.db, randomUUID(), input)).rejects.toThrow(/^SOCIAL_MEDIA_FLAG_POSITIONING_SKILL$/);
  expect(f.rpc).not.toHaveBeenCalled();
  const plain = database();
  await saveModuleSkill(plain.db, randomUUID(), { ...positioningInput(), socialMediaRelated: false });
  expect(plain.rpc).toHaveBeenCalledOnce();
});

it('applies a resent choice for a module whose first publication already bound the Skill (exact retry)', async () => {
  const f = database({ skillBound: true }), input = { ...moduleInput(), expectedUpdatedAt: '2026-10-13T00:00:00.000Z', socialMediaRelated: true };
  await saveModuleSkill(f.db, randomUUID(), input);
  expect(metadata(f.rpc)).toEqual({ ...input.module, active: false });
  expect(f.updates().map(step => step.values)).toEqual([expect.objectContaining({ social_media_related: true }),
    expect.objectContaining({ active: true })]);
  // A module that already has a Skill and no choice sent keeps its flag untouched (its own setting card owns it).
  const absent = database({ skillBound: true }), unchanged = { ...moduleInput(), expectedUpdatedAt: '2026-10-13T00:00:00.000Z' };
  delete unchanged.socialMediaRelated;
  await expect(saveModuleSkill(absent.db, randomUUID(), unchanged)).resolves.toBeTruthy();
  expect(absent.updates()).toEqual([]);
});

it('clears a former prompt module flag before publishing when the choice is No', async () => {
  const f = database({ flagged: true }), input = { ...moduleInput(), expectedUpdatedAt: '2026-10-13T00:00:00.000Z', socialMediaRelated: false };
  await saveModuleSkill(f.db, randomUUID(), input);
  const [clear] = f.updates();
  expect(clear!.values).toMatchObject({ social_media_related: false });
  expect(clear!.filters).toEqual(expect.arrayContaining([['social_media_related', true]]));
  expect(metadata(f.rpc)).toEqual(input.module);
  // Publication expects the version the clearing write produced, not the one the editor opened.
  expect(f.rpc.mock.calls[0]![1].p_expected_updated_at).toBe('2026-10-13T00:00:01.000Z');
  // Cleared first, so the 0219 guard never sees a flagged module become a (positioning) Skill.
  const order = f.steps.filter(step => step.op === 'update').length;
  expect(order).toBe(1);
  // Nothing to clear: an unflagged module publishes without a flag write.
  const plain = database();
  await saveModuleSkill(plain.db, randomUUID(), { ...input });
  expect(plain.updates()).toEqual([]);
  expect(plain.rpc.mock.calls[0]![1].p_expected_updated_at).toBe(input.expectedUpdatedAt);
});

it('continues an exact retry whose flag was already saved before the response was lost', async () => {
  const f = database({ flagged: true }), input = { ...moduleInput(), socialMediaRelated: true };
  await expect(saveModuleSkill(f.db, randomUUID(), input)).resolves.toBeTruthy();
  const updates = f.updates();
  expect(updates.some(step => (step.values as { social_media_related?: boolean }).social_media_related !== undefined)).toBe(false);
  expect(updates.map(step => step.values)).toEqual([expect.objectContaining({ active: true })]);
  expect(updates[0]!.filters).toEqual(expect.arrayContaining([['social_media_related', true], ['updated_at', '2026-10-13T00:00:00.000Z']]));
});

it('requires and applies the choice when an existing prompt module gets its first Skill', async () => {
  const opened = '2026-10-13T00:00:00.000Z';
  const missing = database(), converted = { ...moduleInput(), expectedUpdatedAt: opened };
  delete converted.socialMediaRelated;
  await expect(saveModuleSkill(missing.db, randomUUID(), converted)).rejects.toThrow(/^SOCIAL_MEDIA_FLAG_REQUIRED$/);
  expect(missing.rpc).not.toHaveBeenCalled();
  const f = database(), flagged = { ...moduleInput(), expectedUpdatedAt: opened, socialMediaRelated: true };
  await saveModuleSkill(f.db, randomUUID(), flagged);
  expect(metadata(f.rpc)).toEqual({ ...flagged.module, active: false });
  expect(f.updates().map(step => step.values)).toEqual([expect.objectContaining({ social_media_related: true }),
    expect.objectContaining({ active: true })]);
});
