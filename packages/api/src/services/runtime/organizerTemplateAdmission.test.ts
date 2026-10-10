/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {parseWorkflowManifest} from '../skills/workflowManifest';
import {prepareModuleSkill} from '../skills/modulePublication';
import {GENERIC_ORGANIZER_TEMPLATE} from '../skills/organizerTemplate';
import {expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {packageHash, sha256, type SkillSource} from '../skills/loader';
import {ORGANIZER_INSTRUCTIONS} from '../opc/organizerPrompt';
const source = vi.hoisted(() => ({current: undefined as SkillSource | undefined}));
vi.mock('../skills/databaseSource', () => ({databaseSkillSource: () => source.current}));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(template?: string, oldVersion = false, resources = ['references/step.md'], hostRules = true) {
  const entry = '---\nname: capacity-test\ndescription: Synthetic capacity preflight\n---\nMethod.';
  const files: Record<string, string> = { 'SKILL.md': entry, 'references/step.md': 'PRIVATE_STEP_METHOD',
    'workflow.yaml': 'kind: document\nsteps:\n - title: First\n   resources: [SKILL.md]\n' +
      (oldVersion ? '' : 'organizerTemplate: assets/organize.md\n'),
    'assets/organize.md': template ?? 'SAMPLE_SKILL_TEMPLATE: keep audience and offer separate.' };
  const descriptor = {
    packageId: id(5), revisionId: id(6), directoryName: 'capacity-test',
    files: Object.entries(files).map(([path, content]) => ({
      path, bytes: Buffer.byteLength(content), sha256: sha256(content),
      mediaType: (path.endsWith('.md') ? 'text/markdown' : 'text/yaml') as 'text/markdown' | 'text/yaml', requires: [],
    })), tasks: {}, requiredCapabilities: [], packageHash: '',
  };
  descriptor.packageHash = packageHash(descriptor);
  source.current = {
    list: async () => [descriptor], state: async () => 'enabled',
    read: async ({ path }) => Buffer.from(files[path as keyof typeof files]),
  };
  const input = 'I help beginners learn photography.'; // Existing OPC maximum, not a raised user-input limit.
  const workflow = 'Fixed checklist';
  const organizerInput = JSON.stringify({userInput: input, allowedWorkflow: workflow});
  const additionalInstructions = 'Fixed mentor rules';
  let captured: { p_payload: Record<string, unknown>; p_billing: Record<string, unknown> } | undefined;
  let replay: unknown = null;
  const writes: string[] = [];
  const user = { auth: { getUser: async () => ({ data: {
    user: { id: id(1), email_confirmed_at: '2026-01-01' },
  }, error: null }) } } as unknown as SupabaseClient;
  const admin = {
    rpc: async (name: string, args: { p_payload: Record<string, unknown>; p_billing: Record<string, unknown> }) => {
      if (name === 'runtime_session_context') return { data: {
        scope: { kind: 'positioning_draft', draftId: id(2) }, dialogueModelId: id(3), dialogueModel: 'fixture/mentor',
      }, error: null };
      if (name === 'runtime_admission_replay') return { data: replay, error: null };
      if (name === 'runtime_admit') { writes.push(name); captured = args; return { data: { executionId: id(7) }, error: null }; }
      throw new Error(name);
    },
    from: (table: string) => {
      let modelId = id(3);
      const query = {
        maybeSingle: async () => ({ data: null, error: null }),
        select: () => query, eq: (_key: string, value: string) => { modelId = value; return query; },
        single: async () => ({ data: table === 'modules'
          ? { id: id(4), active: true, skill_id: id(5), model_id: id(3) }
          : { id: modelId, model_id: modelId === id(3) ? 'fixture/mentor' : 'fixture/organizer',
            provider: 'fixture', is_active: 'true', max_tokens: 131072, input_limit: 1000000 }, error: null }),
        in: async () => ({ data: [
          { key: 'v3_summary_model_id', value: id(8) }, { key: 'v3_summary_max_tokens', value: '2048' },
        ], error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const service = runtimeAdmissionService(user, admin, {
    account: 'synthetic', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1', maxCalls: 2,
    opcTurnToken: id(9), purposeBudgets: false, maxOutputTokens: 1000, inputBytes: 200000, historyItems: 100, additionalInstructions,
    skillResources: resources, organizerInput, organizerInstructions: hostRules ? ORGANIZER_INSTRUCTIONS : undefined,
  });
  const request = { sessionId: id(2), requestId: id(7), input, organizeAfter: true,
    selection: { kind: 'skill' as const, moduleId: id(4), revisionId: id(6) }, network: 'deny' };
  return { files, descriptor, run: (override: Record<string, unknown> = {}) => service.prepare({...request,...override}), captured: () => captured!, writes,
    replay: (value: unknown) => { replay = value; } };
}
it('freezes the selected Skill template in the actual organizer request, separate from mentor material', async () => {
  const f = await fixture(); await f.run();
  const context = f.captured().p_payload;
  const organizer = context.attachedOrganizer as {instructions: string};
  expect(organizer.instructions).toContain('SAMPLE_SKILL_TEMPLATE');
  expect(organizer.instructions).toContain(ORGANIZER_INSTRUCTIONS);
  expect(organizer.instructions).not.toContain('PRIVATE_STEP_METHOD');
  expect(context.instructions).not.toContain('SAMPLE_SKILL_TEMPLATE');
  const frozen = structuredClone(context);
  f.replay({executionId: id(7), context: frozen});
  source.current = undefined;
  const replay = await f.run();
  expect(replay.context).toEqual(frozen);
  expect(f.writes).toHaveLength(1);
});
it('an old draft without declaration keeps the original general template', async () => {
  const f = await fixture(undefined, true); await f.run();
  expect((f.captured().p_payload.attachedOrganizer as {instructions: string}).instructions).toBe(ORGANIZER_INSTRUCTIONS);
});
it('rejects an invalid declared template before any reservation or admission', async () => {
  const f = await fixture('x'.repeat(3001));
  await expect(f.run()).rejects.toThrow('CAPACITY_EXCEEDED');
  expect(f.writes).toEqual([]);
});
vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal(), ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));

// Private source is supplied only for the local release-package check; never committed or printed.
it.runIf(process.env.AGENT_CORE_R3_PACKAGE_DIR)(
  'the prepared positioning package passes publication and freezes its own template on a fixed sample', async () => {
    const root = process.env.AGENT_CORE_R3_PACKAGE_DIR!;
    const files: Record<string, string> = {};
    function read(directory: string, prefix = '') {
      for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) read(join(directory, entry.name), path + '/');
        else files[path] = readFileSync(join(directory, entry.name), 'utf8');
      }
    }
    read(root);
    const {organizerTemplate, ...workflow} = parseWorkflowManifest(files['workflow.yaml']!);
    if (!organizerTemplate) throw new Error('Missing organizer template declaration');
    const directoryName = root.split('/').at(-1)!;
    const published = prepareModuleSkill({moduleId: id(4), skillId: id(5), revisionId: id(6), requestId: id(7),
      expectedUpdatedAt: null, expectedVersion: 11, directoryName, ...workflow,
      files: Object.entries(files).map(([path, text]) => ({path, base64: Buffer.from(text).toString('base64')})),
      resourcePlanReviewed: true, module: {title: 'Private package validation', description: null, full_description: null,
        model_id: id(3), platform: 'all', category: 'marketing', icon: 'Wand2', image_url: null,
        badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
        features: null, examples: null, preparation_questions: null}});
    const f = await fixture(undefined, false, workflow.steps[0]!.resources);
    source.current = {list: async () => [published.descriptor], state: async () => 'enabled',
      read: async ({path}) => Buffer.from(files[path]!)};
    // Actual admission uses the real package resources, with synthetic identities/models and SQL boundary.
    await f.run();
    const instructions = (f.captured().p_payload.attachedOrganizer as {instructions: string}).instructions;
    // Boolean assertions intentionally avoid echoing private text on failure.
    expect(instructions.includes(files[organizerTemplate]!)).toBe(true);
    expect(instructions.includes(ORGANIZER_INSTRUCTIONS)).toBe(true);
    expect(instructions.includes(files['SKILL.md']!)).toBe(false);
    expect(published.workflow.version).toBe(12);
    expect(f.writes).toEqual(['runtime_admit']);
  });

it('uses declared templates and general fallback for non-positioning Skill callers as well', async () => {
  const custom = await fixture(undefined, false, undefined, false); await custom.run();
  const instructions = (custom.captured().p_payload.attachedOrganizer as {instructions: string}).instructions;
  expect(instructions).toContain('SAMPLE_SKILL_TEMPLATE');
  expect(instructions).toContain(GENERIC_ORGANIZER_TEMPLATE);
  const legacy = await fixture(undefined, true, undefined, false); await legacy.run();
  expect((legacy.captured().p_payload.attachedOrganizer as {instructions: string}).instructions).toBe(GENERIC_ORGANIZER_TEMPLATE);
});
