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
