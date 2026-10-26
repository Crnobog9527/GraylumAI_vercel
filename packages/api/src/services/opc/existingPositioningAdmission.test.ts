/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {beforeEach, expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {LocalRuntimePolicy} from '../runtime/admission';
import {opcService} from './service';
import {OPENING_INPUT} from './questions';
import {agentTurnInstructions} from './agentTurnPrompt';

const captured = vi.hoisted(() => ({policy: undefined as LocalRuntimePolicy | undefined}));
vi.mock('../runtime/admission', () => ({
  runtimeAdmissionService: (_user: unknown, _admin: unknown, policy: LocalRuntimePolicy) => {
    captured.policy = policy;
    return {prepare: async () => ({executionId: 'synthetic'})};
  },
}));
vi.mock('../artifacts/workbench', () => ({workbenchService: () => ({read: async () => ({
  state: 'draft', revisionId: id, workflow: {steps}, steps: {first: {valid: false}, later: {valid: false}},
})})}));
const id = '10000000-0000-4000-8000-000000000001';
const steps = [{id: 'first', title: '了解你', resources: []}, {id: 'later', title: 'Later', resources: []}];
const schema = [{id: 'goal', title: 'Goal', required: true}];
const normalOpening = "Open this step's discussion naturally from known material";
const intake = 'ask the user to paste or describe their existing positioning';

function fixture(mode: 'manual' | 'mentor', saved = false, replay = false) {
  const values = saved ? {goal: {value: 'Existing material', status: 'provisional'}} : {};
  const information = {first: {schema, values}, later: {schema, values: {}}};
  const rpc = vi.fn((name: string) => {
    const data: Record<string, unknown> = {
      opc_query: {mode, projectId: id, roundId: id, sessionId: id, information},
      artifact_query: {moduleId: id, workflow: {steps}},
      runtime_admission_replay: replay ? {executionId: id} : null,
      runtime_session_context: {waitingOrganizer: null, scopeMaterial: {revision: 1, content: {work: {
        roundId: id, steps: {first: {information: values}, later: {information: {}}},
      }}}},
      opc_capture_apply: {processed: [], remaining: 0, hasMore: false},
      opc_step_material: {revision: 1, turnToken: id},
    };
    if (!(name in data)) throw new Error('Unexpected RPC: ' + name);
    const result = Promise.resolve({data: data[name], error: null});
    return Object.assign(result, {abortSignal: () => result});
  });
  const user = {auth: {getUser: async () => ({data: {user: {id, email_confirmed_at: '2026-01-01'}}, error: null})}};
  return opcService(user as unknown as SupabaseClient, {rpc} as unknown as SupabaseClient);
}
const request = {draftId: id, requestId: id, stepId: 'first', purpose: 'mentor', questionId: 'goal',
  input: OPENING_INPUT, organizeAfter: false};
beforeEach(() => {captured.policy = undefined;});

it('freezes only import intake for a new manual opening, without a competing interview opening', async () => {
  await fixture('manual').prepareStep(request);
  const policy = captured.policy!;
  expect(policy.hostTurnContext).toMatchObject({opening: true, stepId: 'first',
    confirmation: {stepReady: false, stepConfirmed: false}});
  expect(policy.additionalInstructions).toContain(intake);
  expect(policy.additionalInstructions).not.toContain(normalOpening);
  expect(policy.additionalInstructions).toContain('Never treat supplied positioning or verbal assent as confirmation');
  expect(policy.stableAdditionalInstructions).toBe(policy.additionalInstructions);
  expect(policy.organizerInstructions).toContain('Never confirm or defer a field');
  // Preserve the existing explicit-purpose-budget requirement, also exercised by the SQL integration.
  expect(policy.additionalInstructions!.length).toBeGreaterThan(8000);
});

it('keeps the normal mentor opening unchanged', async () => {
  await fixture('mentor').prepareStep(request);
  expect(captured.policy!.additionalInstructions).toBe(agentTurnInstructions());
  expect(captured.policy!.additionalInstructions).toContain(normalOpening);
  expect(captured.policy!.additionalInstructions).not.toContain(intake);
});

it('reviews already recorded manual material without restarting import intake', async () => {
  await fixture('manual', true).prepareStep(request);
  expect(captured.policy!.additionalInstructions).toContain('review the supplied positioning');
  expect(captured.policy!.additionalInstructions).not.toContain(intake);
  expect(captured.policy!.additionalInstructions).toContain(normalOpening);
});

it('returns the same frozen execution on replay before building a new opening', async () => {
  await expect(fixture('manual', false, true).prepareStep(request)).resolves.toEqual({executionId: id});
  expect(captured.policy).toBeUndefined();
});
