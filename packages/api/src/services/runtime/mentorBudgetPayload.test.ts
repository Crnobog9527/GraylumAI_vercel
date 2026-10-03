/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeAdmissionService } from './admission';
import { postgresJsonbBytes } from './payloadSize';
import { PURPOSE_INPUT_CAPS, PURPOSE_OUTPUT_CAP, type PurposeBudgets } from './purposeBudgets';
import { packageHash, sha256, type SkillSource } from '../skills/loader';

const source = vi.hoisted(() => ({ current: undefined as SkillSource | undefined }));
vi.mock('../skills/databaseSource', () => ({ databaseSkillSource: () => source.current }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Capacity preflight, not a real Skill/model execution. Actual admission and
 * Skill loader; synthetic authorized source/SQL boundary. PostgreSQL jsonb
 * lengths are measured separately from these captured arguments. */
async function fixture(resourceBytes: number, worst = false, budgets?: PurposeBudgets, extraBytes = 0) {
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
  const input = (worst ? '\u0001' : '中').repeat(8000); // Existing OPC maximum, not a raised user-input limit.
  const workflow = '文'.repeat(3000);
  const organizerInput = worst ? '\u0001'.repeat(972) + '中'.repeat(23027) + '\\' : JSON.stringify({ userInput: input, allowedWorkflow: workflow });
  const additionalInstructions = worst ? '中'.repeat(8000) + 'x'.repeat(extraBytes) : 'Instruction. '.repeat(250) + workflow;
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
        maybeSingle: async () => ({ data: budgets ? { value: JSON.stringify(budgets) } : null, error: null }),
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
    opcTurnToken: id(9), purposeBudgets: Boolean(budgets), maxOutputTokens: 1000, inputBytes: 200000, historyItems: 100, additionalInstructions,
    skillResources: ['references/step.md'], organizerInput, organizerInstructions: worst ? '中'.repeat(12000) : 'Extract facts. '.repeat(400),
  });
  const request = { sessionId: id(2), requestId: id(7), input, organizeAfter: true,
    selection: { kind: 'skill' as const, moduleId: id(4), revisionId: id(6) }, network: 'deny' };
  return { run: (override: Record<string, unknown> = {}) => service.prepare({...request,...override}), captured: () => captured!, writes,
    replay: (value: unknown) => { replay = value; } };
}
const config: PurposeBudgets = { version: 1,
  interactive: { inputBytes: PURPOSE_INPUT_CAPS.interactive, maxOutputTokens: PURPOSE_OUTPUT_CAP, historyItems: 1000 },
  organize: { inputBytes: PURPOSE_INPUT_CAPS.organize, historyItems: 1000 },
  report: { inputBytes: PURPOSE_INPUT_CAPS.report, maxOutputTokens: PURPOSE_OUTPUT_CAP, historyItems: 1000 } };
function sizedInput(context: Record<string, unknown>) {
  return Buffer.byteLength(JSON.stringify({ instructions: context.instructions,
    messages: [{ role: 'user', content: context.input }] })) + 1024;
}
it('46KB resource fits configured input; overflowing frozen payload is rejected before the SQL admission', async () => {
  const normal = await fixture(46000, false, config);
  await normal.run();
  expect(postgresJsonbBytes(normal.captured().p_billing)).toBeLessThan(262144 - 8192);
  const oversized = await fixture(162000);
  await expect(oversized.run()).rejects.toThrow('RUNTIME_FROZEN_PAYLOAD_TOO_LARGE');
  expect(oversized.writes).toEqual([]);
  expect(oversized.captured()).toBeUndefined();
});
it('worst allowed composition fits at the exact input hard cap with 8KiB storage margin; one extra byte is refused', async () => {
  const empty = await fixture(0, true, config);
  await empty.run();
  const resourceSize = PURPOSE_INPUT_CAPS.interactive - sizedInput(empty.captured().p_payload);
  const exact = await fixture(resourceSize, true, config);
  await exact.run();
  const captured = exact.captured();
  const organizer = captured.p_payload.attachedOrganizer as Record<string, unknown>;
  expect(sizedInput(organizer)).toBe(PURPOSE_INPUT_CAPS.organize);
  expect(sizedInput(captured.p_payload)).toBe(PURPOSE_INPUT_CAPS.interactive);
  expect(postgresJsonbBytes(captured.p_payload)).toBeLessThanOrEqual(262144 - 8192);
  expect(postgresJsonbBytes(captured.p_billing)).toBeLessThanOrEqual(262144 - 8192);
  const over = await fixture(resourceSize + 1, true, config);
  await expect(over.run()).rejects.toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  expect(over.writes).toEqual([]);
  if (process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR) {
    writeFileSync(`${process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR}/configured-worst.json`, JSON.stringify(captured));
    // B has no admission route yet. Measure its reserved envelope conservatively
    // with the same attached-organizer composition, without enabling generation.
    const report = structuredClone(captured);
    (report.p_payload.purposeBudget as {purpose:string}).purpose = 'report';
    ((report.p_billing.input as Record<string,unknown>).purposeBudget as {purpose:string}).purpose = 'report';
    expect(postgresJsonbBytes(report.p_billing)).toBeLessThan(262144-8192);
    writeFileSync(`${process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR}/report-envelope.json`, JSON.stringify(report));
  }
});
it('replay bypasses changed administrator configuration and the original frozen input remains unchanged', async () => {
  const settings = structuredClone(config), f = await fixture(46000, false, settings);
  await f.run();
  const old = structuredClone(f.captured());
  settings.interactive.inputBytes = 1024;
  f.replay({ executionId: id(7), context: old.p_payload });
  expect(await f.run()).toEqual({ executionId: id(7), context: old.p_payload });
  expect(f.captured()).toEqual(old);
  f.replay(null);
  await expect(f.run()).rejects.toThrow('CAPACITY_EXCEEDED');
  expect(f.writes).toHaveLength(1);
});

it('exact database payload boundary admits, then one more byte refuses before execution or reservation',async()=>{
 const base=await fixture(0);await base.run();
 const size=262144-postgresJsonbBytes(base.captured().p_billing);
 const exact=await fixture(size);await exact.run();
 expect(postgresJsonbBytes(exact.captured().p_billing)).toBe(262144);
 const over=await fixture(size+1);await expect(over.run()).rejects.toThrow('RUNTIME_FROZEN_PAYLOAD_TOO_LARGE');
 expect(over.writes).toEqual([]);expect(over.captured()).toBeUndefined();
});

it('standalone organization fits at its exact input cap and rejects one more byte before admission',async()=>{
 const request={selection:{kind:'organizer'},organizeAfter:false};
 const empty=await fixture(0,true,config);await empty.run(request);
 const extra=PURPOSE_INPUT_CAPS.organize-sizedInput(empty.captured().p_payload);
 const f=await fixture(0,true,config,extra);await f.run(request);
 expect(sizedInput(f.captured().p_payload)).toBe(PURPOSE_INPUT_CAPS.organize);
 expect(f.captured().p_payload).toMatchObject({maxOutputTokens:2048,historyItems:1000,
  purposeBudget:{purpose:'organize',inputBytes:112000,historyItems:1000}});
 expect(postgresJsonbBytes(f.captured().p_billing)).toBeLessThan(262144-8192);
 const over=await fixture(0,true,config,extra+1);
 await expect(over.run(request)).rejects.toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 expect(over.writes).toEqual([]);
 if(process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR)writeFileSync(
  `${process.env.MENTOR_PAYLOAD_PREFLIGHT_DIR}/organize-worst.json`,JSON.stringify(f.captured()));
});

vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
