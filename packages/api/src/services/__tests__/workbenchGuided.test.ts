/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '../artifacts/workflow';
import { makeWorkflow } from './fixtures/artifacts';

const started = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../artifacts/store', async importOriginal => ({
  ...await importOriginal<typeof import('../artifacts/store')>(),
  databaseArtifactStore: () => ({ start: async (input: { roundId: string }) => {
    started.calls.push(input);
    return { roundId: input.roundId };
  } }),
}));
import { workbenchService } from '../artifacts/workbench';

const ids = { moduleId: randomUUID(), skillId: randomUUID(), revisionId: randomUUID() };

/** Positioning (CONTENT-CONVERSATION-DRIVEN G): every step declares questions and one feeds the profile. */
function positioning(): Workflow {
  const flow = makeWorkflow(2);
  flow.steps.forEach((step, i) => {
    step.information = [{ id: `field${i}`, title: `Field ${i}`, required: false, ...(i === 0 ? { profileKey: 'audience' } : {}) }];
  });
  return flow;
}
/** Every step asks questions but none feeds the positioning profile: still not a guided workflow. */
function questionsWithoutProfile(): Workflow {
  const flow = makeWorkflow(2);
  flow.steps.forEach((step, i) => { step.information = [{ id: `field${i}`, title: `Field ${i}`, required: false }]; });
  return flow;
}

function clients(workflow: Workflow, prior?: Workflow) {
  const registration = { id: 'registered', label: 'Method', ...ids, packageHash: 'a'.repeat(64), workflow, accounts: [] };
  const user = {
    auth: { getUser: async () => ({ data: { user: { id: randomUUID(), email_confirmed_at: new Date().toISOString() } }, error: null }) },
    from: () => ({ select: () => ({ in: () => ({ eq: async () => ({ data: [{ id: ids.moduleId, active: true }], error: null }) }) }) }),
  };
  const admin = {
    rpc: (_name: string, args: { p_action: string }) => ({ abortSignal: async () => ({
      data: args.p_action === 'catalog' ? [registration] : { ...ids, account: null, workflow: prior ?? workflow },
      error: null,
    }) }),
  };
  return workbenchService(user as never, admin as never);
}
const scope = () => ({ projectId: randomUUID(), roundId: randomUUID(), requestId: randomUUID() });

describe('workbench guided step workspace (positioning only)', () => {
  beforeEach(() => { started.calls = []; });

  it('starts a positioning workflow', async () => {
    const input = { ...scope(), registration: 'registered' };
    await expect(clients(positioning()).start(input)).resolves.toEqual({ roundId: input.roundId });
    expect(started.calls).toHaveLength(1);
  });

  it.each([
    ['plain steps', makeWorkflow(3)],
    ['questions without a profile key', questionsWithoutProfile()],
  ])('refuses a non-positioning workflow (%s) before any write', async (_name, workflow) => {
    await expect(clients(workflow).start({ ...scope(), registration: 'registered' }))
      .rejects.toThrow('ARTIFACT_INVALID_WORKFLOW');
    expect(started.calls).toHaveLength(0);
  });

  it('refuses a next round of an existing non-positioning project and an upgrade to one', async () => {
    const next = clients(makeWorkflow(3)).start({ ...scope(), fromRoundId: randomUUID() });
    await expect(next).rejects.toThrow('ARTIFACT_INVALID_WORKFLOW');
    const upgrade = clients(makeWorkflow(3), positioning())
      .start({ ...scope(), fromRoundId: randomUUID(), upgrade: true, registration: 'registered' });
    await expect(upgrade).rejects.toThrow('ARTIFACT_INVALID_WORKFLOW');
    expect(started.calls).toHaveLength(0);
  });

  it('continues a positioning project into its next round', async () => {
    const input = { ...scope(), fromRoundId: randomUUID() };
    await expect(clients(positioning()).start(input)).resolves.toEqual({ roundId: input.roundId });
  });
});
