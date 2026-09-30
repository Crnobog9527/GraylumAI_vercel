/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeAdmissionService } from './admission';
import { packageHash, sha256, type SkillSource } from '../skills/loader';

const source = vi.hoisted(() => ({ current: undefined as SkillSource | undefined }));
vi.mock('../skills/databaseSource', () => ({ databaseSkillSource: () => source.current }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Capacity preflight, not a real Skill/model execution. Actual admission and
 * Skill loader; synthetic authorized source/SQL boundary. PostgreSQL jsonb
 * lengths are measured separately from these captured arguments. */
it.each([46000, 162000])('captures frozen payload for %i resource bytes', async resourceBytes => {
  const entry = '---\nname: capacity-test\ndescription: Synthetic capacity preflight\n---\nMethod.';
  const files = { 'SKILL.md': entry, 'references/step.md': 'x'.repeat(resourceBytes) };
  const descriptor = {
    packageId: id(5), revisionId: id(6), directoryName: 'capacity-test',
    files: Object.entries(files).map(([path, content]) => ({
      path, bytes: Buffer.byteLength(content), sha256: sha256(content),
      mediaType: 'text/markdown' as const, requires: [],
    })), tasks: {}, requiredCapabilities: [], packageHash: '',
  };
  descriptor.packageHash = packageHash(descriptor);
  source.current = {
    list: async () => [descriptor], state: async () => 'enabled',
    read: async ({ path }) => Buffer.from(files[path as keyof typeof files]),
  };
  const input = '中'.repeat(8000); // Existing OPC maximum, not a raised user-input limit.
  const workflow = '文'.repeat(3000);
  const organizerInput = JSON.stringify({ userInput: input, allowedWorkflow: workflow });
  const additionalInstructions = 'Instruction. '.repeat(250) + workflow;
  let captured: { p_payload: unknown; p_billing: unknown } | undefined;
  const user = { auth: { getUser: async () => ({ data: {
    user: { id: id(1), email_confirmed_at: '2026-01-01' },
  }, error: null }) } } as unknown as SupabaseClient;
  const admin = {
    rpc: async (name: string, args: { p_payload: unknown; p_billing: unknown }) => {
      if (name === 'runtime_session_context') return { data: {
        scope: { kind: 'positioning_draft', draftId: id(2) }, dialogueModelId: id(3), dialogueModel: 'fixture/mentor',
      }, error: null };
      if (name === 'runtime_admission_replay') return { data: null, error: null };
      if (name === 'runtime_admit') { captured = args; return { data: { executionId: id(7) }, error: null }; }
      throw new Error(name);
    },
    from: (table: string) => {
      let modelId = id(3);
      const query = {
        select: () => query, eq: (_key: string, value: string) => { modelId = value; return query; },
        single: async () => ({ data: table === 'modules'
          ? { id: id(4), active: true, skill_id: id(5), model_id: id(3) }
          : { id: modelId, model_id: modelId === id(3) ? 'fixture/mentor' : 'fixture/organizer',
            provider: 'fixture', is_active: 'true', max_tokens: 4096, input_limit: 1000000 }, error: null }),
        in: async () => ({ data: [
          { key: 'v3_summary_model_id', value: id(8) }, { key: 'v3_summary_max_tokens', value: '2048' },
        ], error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  await runtimeAdmissionService(user, admin, {
    account: 'synthetic', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1', maxCalls: 2,
    maxOutputTokens: 1000, inputBytes: 200000, historyItems: 100, additionalInstructions,
    skillResources: ['references/step.md'], organizerInput, organizerInstructions: 'Extract facts. '.repeat(400),
  }).prepare({ sessionId: id(2), requestId: id(7), input, organizeAfter: true,
    selection: { kind: 'skill', moduleId: id(4), revisionId: id(6) }, network: 'deny' });
  expect(captured).toBeDefined();
  // Optional local evidence export contains synthetic material only.
  if (process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR) {
    writeFileSync(`${process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR}/payload-${resourceBytes}.json`, JSON.stringify(captured));
  }
  const bytes = Buffer.byteLength(JSON.stringify(captured!.p_billing));
  if (resourceBytes === 46000) expect(bytes).toBeLessThan(262144);
  else expect(bytes).toBeGreaterThan(262144);
});
