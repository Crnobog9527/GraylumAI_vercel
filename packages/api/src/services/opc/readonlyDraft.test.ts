/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readonlyDraftProjection } from './readonlyDraft';

const full = {
  conversationDeleted: true, draftId: 'd', projectId: 'p', roundId: 'r', sessionId: 's', mode: 'mentor',
  snapshot: { state: 'draft', workflow: { steps: [{ id: 's1', title: '目标', prompt: 'PRIVATE_PROMPT' }] },
    steps: { s1: { version: 3, reviewVersion: 1, valid: false, information: { goal: { value: 'PROVISIONAL_TEXT' } } } } },
  information: { s1: { schema: [{ id: 'goal', title: '目标', hint: 'x' }, { id: 'aud', title: '受众' }],
    values: { goal: { value: '已确认目标', status: 'confirmed', nature: 'fact' },
      aud: { value: 'UNCONFIRMED_MANUAL_TEXT', status: 'provisional' } },
    meta: { goal: { suggestion: { value: 'SUGGESTED_TEXT' } } }, notes: ['NOTE_TEXT'] } },
  turns: [{ executionId: 'e', text: 'TURN_TEXT' }], plans: [{ body: 'PLAN_TEXT' }], handoffs: [{ result: 'HANDOFF' }],
  report: { body: 'REPORT_TEXT' },
};

describe('readonlyDraftProjection', () => {
  it('returns confirmed values only and nothing else the read-only page does not show', () => {
    const projection = readonlyDraftProjection(full);
    expect(projection.information.s1.values).toEqual({ goal: { value: '已确认目标', status: 'confirmed', nature: 'fact' } });
    expect(JSON.stringify(projection)).not.toMatch(/PROVISIONAL_TEXT|UNCONFIRMED_MANUAL_TEXT|SUGGESTED_TEXT|NOTE_TEXT|TURN_TEXT|PLAN_TEXT|HANDOFF|REPORT_TEXT|PRIVATE_PROMPT/);
    expect(projection.snapshot.steps.s1).toEqual({ version: 3, reviewVersion: 1, valid: false });
    expect(projection.conversationDeleted).toBe(true);
  });

  it('keeps the body of a confirmed step, but not of an unconfirmed one', () => {
    const steps = { s1: { version: 2, reviewVersion: 0, valid: true, body: '已确认的步骤结论' },
      s2: { version: 1, reviewVersion: 0, valid: false, body: 'UNCONFIRMED_STEP_BODY' } };
    const projection = readonlyDraftProjection({ ...full, snapshot: { ...full.snapshot,
      workflow: { steps: [{ id: 's1', title: '目标' }, { id: 's2', title: '受众' }] }, steps } });
    expect(projection.snapshot.steps.s1).toEqual({ version: 2, reviewVersion: 0, valid: true, body: '已确认的步骤结论' });
    expect(JSON.stringify(projection)).not.toMatch(/UNCONFIRMED_STEP_BODY/);
  });

  it('tolerates missing parts', () => {
    expect(readonlyDraftProjection({ conversationDeleted: true }).information).toEqual({});
  });
});

describe('draftReadResponse', () => {
  it('serves the confirmed-only projection for a deleted conversation without touching other reads', async () => {
    const { draftReadResponse } = await import('./readonlyDraft');
    const rpc = async () => { throw new Error('no other read for a read-only draft'); };
    const response = await draftReadResponse(full, rpc);
    expect(JSON.stringify(response)).not.toMatch(/UNCONFIRMED_MANUAL_TEXT|TURN_TEXT|REPORT_TEXT/);
    expect(response).toMatchObject({ conversationDeleted: true, turns: [], plans: [], handoffs: [], report: null });
  });
});

describe('draftReadWithModule', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const live = (ids: { projectId: string; roundId: string }) => ({ draftId: 'd', ...ids, sessionId: 's',
    snapshot: { projectId: id(2), roundId: id(3), state: 'draft', workflow: { id: 'w', steps: [] }, steps: {} }, information: {} });
  const noActor = async () => { throw new Error('the session is not asked when the frozen round already answered'); };
  const noAdmin = { rpc: () => { throw new Error('no second lookup'); } };

  it('takes the module from the frozen-round lookup of the report flag: one query, not two', async () => {
    const { draftReadWithModule } = await import('./readonlyDraft');
    const calls: Array<Record<string, unknown>> = [];
    const rpc = async (_name: string, args: Record<string, unknown>) => { calls.push(args); return { moduleId: id(20), workflow: { reportGeneration: null } }; };
    const response = await draftReadWithModule(live({ projectId: id(2), roundId: id(3) }), rpc, noActor, noAdmin);
    expect(response).toMatchObject({ moduleId: id(20), snapshot: { workflow: { reportGeneration: false } } });
    expect(calls).toEqual([{ p_action: 'resolve', p_project_id: id(2), p_round_id: id(3) }]);
  });

  it('answers no module when the frozen round names none', async () => {
    const { draftReadWithModule } = await import('./readonlyDraft');
    const response = await draftReadWithModule(live({ projectId: id(2), roundId: id(3) }), async () => ({ workflow: {} }), noActor, noAdmin);
    expect(response.moduleId).toBeNull();
  });

  it('looks the module up by the read\'s own ids when they are not the snapshot\'s', async () => {
    const { draftReadWithModule } = await import('./readonlyDraft');
    const lookups: Array<Record<string, unknown>> = [];
    const admin = { rpc: async (_name: string, args: Record<string, unknown>) => { lookups.push(args); return { data: { moduleId: id(21) } }; } };
    const response = await draftReadWithModule(live({ projectId: id(5), roundId: id(6) }), async () => ({ moduleId: id(20) }), async () => id(9), admin);
    expect(response.moduleId).toBe(id(21));
    expect(lookups).toEqual([{ p_actor_id: id(9), p_action: 'resolve', p_project_id: id(5), p_round_id: id(6) }]);
  });

  it('fails the read when the frozen round cannot be read, and has no module for a deleted conversation', async () => {
    const { draftReadWithModule } = await import('./readonlyDraft');
    await expect(draftReadWithModule(live({ projectId: id(2), roundId: id(3) }), async () => { throw new Error('statement timeout'); }, noActor, noAdmin))
      .rejects.toThrow('statement timeout');
    const deleted = await draftReadWithModule(full, async () => { throw new Error('no other read for a read-only draft'); }, noActor, noAdmin);
    expect(deleted).toMatchObject({ conversationDeleted: true, moduleId: null });
  });
});
