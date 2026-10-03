/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { sliceAdmission } from '../agentSlice/admission';
import { workbenchGeneration } from '../artifacts/generation';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from '../runtime/rateLimitSettings';
import { runtimeGateMessages } from '../../shared/runtimeGateMessages';
const id = '00000000-0000-4000-8000-000000000001';
const scope = { projectId: id, roundId: id, stepId: 'step' };
function fixture(replay = false, paused = true) {
  const user = { auth: { getUser: async () => ({
    data: { user: { id, email: 'fixture@example.test', email_confirmed_at: '2026-01-01' } }, error: null,
  }) } };
  const record = { requestId: id, projectId: id, roundId: id, revisionId: id };
  const rpc = vi.fn((name: string) => {
    if (!['agent_slice_admission_replay', 'artifact_generation'].includes(name)) throw new Error('PAID_WORK_REACHED');
    const response = Promise.resolve({ data: replay ? record : null, error: null });
    return Object.assign(response, { abortSignal: () => response });
  });
  const settings = { select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { value: { ...defaults, stopNewCalls: paused } }, error: null }) };
  const admin = { rpc, from: vi.fn(() => settings) };
  return { user, admin, record };
}
it('blocks a new legacy slice before models, reservation or admission', async () => {
  const f = fixture();
  await expect(sliceAdmission(f.user as never, f.admin as never).begin({ ...scope,
    conversationId: id, requestId: id, pairId: 'pair', body: 'synthetic', preferenceRefs: [],
  })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: runtimeGateMessages.paused });
  expect(f.admin.rpc.mock.calls.map(([name]) => name)).toEqual(['agent_slice_admission_replay']);
});
it('keeps a legacy slice replay available without even reading the pause setting', async () => {
  const f = fixture(true);
  expect(await sliceAdmission(f.user as never, f.admin as never).begin({ ...scope,
    conversationId: id, requestId: id, pairId: 'pair', body: 'synthetic', preferenceRefs: [],
  })).toEqual(f.record);
  expect(f.admin.from).not.toHaveBeenCalled();
});
it('blocks new workbench generation before reservation or provider transport', async () => {
  const f = fixture();
  const transport = vi.fn();
  const generation = workbenchGeneration(f.user as never, f.admin as never, transport);
  await expect(generation.generate({ ...scope, requestId: id, quoteHash: 'a'.repeat(64), budgetCredits: 1,
    instruction: '', expectedSteps: { step: { version: 0, reviewVersion: 0 } },
  })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: runtimeGateMessages.paused });
  expect(f.admin.rpc).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
});
