/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// In-memory stand-ins for the database record (0236/0256), admission and settings. The orchestration,
// prompts and host checks under test are the real ones.
type Call = { groupId: string; runId: string; callId: string; modelId: string; phase: string; dispatched: boolean;
  verdict: string | null; settled: boolean; state: string };
const db = vi.hoisted(() => ({ review: null as Record<string, unknown> | null, calls: [] as Call[], outputs: new Map<string, string>(),
  groups: new Map<string, { groupId: string; runs: Array<{ runId: string; index: number; phase: string; body: string; call: { model: string } }> }>() }));
const ids = { reviewers: ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'], summary: '00000000-0000-4000-8000-0000000000b1' };
vi.mock('./settings', () => ({ readFusionSettings: async () => ({ version: 1, compare: { enabled: false }, review: { enabled: true,
  reviewerModelIds: ids.reviewers, summaryModelId: ids.summary, skillId: '00000000-0000-4000-8000-0000000000c1', maxRounds: 2,
  opinionOutputTokens: 1000, summaryOutputTokens: 2000, maxBudgetUsd: '5', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } } }) }));
vi.mock('../runtime/stagingPolicy', () => ({ loadStagingPolicy: async () => ({ callPolicies: [...ids.reviewers, ids.summary].map(modelId => ({ modelId,
  outputLimit: 8192, providerLimits: { providerSlug: 'x', contextTokens: 400000, promptUsdPerMillion: '0.1', completionUsdPerMillion: '0.1', requestUsd: '0' } })) }) }));
vi.mock('./reviewPrompts', async original => ({ ...(await original<typeof import('./reviewPrompts')>()),
  resolveReviewSkill: async () => ({ skillId: '00000000-0000-4000-8000-0000000000c1', revisionId: '00000000-0000-4000-8000-0000000000c2', packageHash: 'a'.repeat(64) }),
  readReviewSkill: async () => ({ reviewer: 'review', summary: 'summarize', rubric: 'rubric' }) }));
vi.mock('./admission', async original => ({ ...(await original<typeof import('./admission')>()),
  admitFusionGroup: async (input: { requestId: string; members: Array<{ modelId: string; phase: string; request: { input: string } }> }) => {
    const existing = db.groups.get(input.requestId);
    if (existing) return { ...existing, replayed: true };
    const group = { groupId: randomUUID(), runs: input.members.map((m, index) => ({ runId: randomUUID(), index, phase: m.phase,
      body: m.request.input, call: { model: m.modelId } })) };
    db.groups.set(input.requestId, group);
    return { ...group, replayed: false };
  },
  replayFusionGroup: async (_a: unknown, _b: unknown, requestId: string) => db.groups.get(requestId) ?? null }));
vi.mock('./reviewRecord', async original => {
  const real = await original<typeof import('./reviewRecord')>();
  const view = () => ({ ...db.review!, calls: db.calls.map(c => ({ ...c })) });
  return { ...real, reviewRecord: () => ({
    start: async (input: { config: unknown }) => { db.review = { reviewId: randomUUID(), state: 'running', round: 1, phase: 'review', attempt: 1,
      draftId: randomUUID(), sourceVersionId: randomUUID(), sourceSessionId: randomUUID(), versionHash: 'h',
      materials: { s1: { goal: { value: '旧目标', status: 'confirmed' } } }, materialsHash: 'a'.repeat(64), config: input.config, steps: [],
      outcome: null, revisionId: null, endedAt: null }; return view(); },
    read: async () => db.review ? view() : null,
    claim: async (_id: string, at: { round: number; phase: string; attempt: number }, groupId: string, items: Array<{ runId: string; payload: { model: string } }>) => {
      const key = `review:${at.round}:${at.phase}:${at.attempt}`;
      (db.review!.steps as unknown[]).push({ ...at, groupId, stepKey: key, claimedAt: 'now' });
      for (const item of items) db.calls.push({ groupId, runId: item.runId, callId: randomUUID(), modelId: item.payload.model,
        phase: at.phase === 'review' ? 'fusion_review' : 'fusion_summary', dispatched: false, verdict: null, settled: false, state: 'prepared' });
      return { state: 'claimed', calls: [] };
    },
    advance: async (_id: string, _from: unknown, to: Record<string, unknown>) => {
      if (to.state === 'running') Object.assign(db.review!, { round: to.round, phase: to.phase, attempt: to.attempt });
      else Object.assign(db.review!, { state: to.state, outcome: to.outcome, revisionId: to.revisionId ?? null });
      return view();
    },
    close: async (_id: string, state: string) => { db.review!.state = state; return view(); },
  }) };
});
import { reviewFlow } from './review';
import { summaryRequest } from './reviewPrompts';

const sections = ['定位', '结语'];
const original = '## 定位\n原定位\n## 结语\n原结语';
const admin = { rpc: async (name: string, args: Record<string, unknown>) => {
  if (name === 'fusion_review_preview') return { data: { reportBytes: 2000, materialsBytes: 500, fieldCount: 1 }, error: null };
  if (name === 'fusion_review_source') return { data: { body: original, sections, maxCharacters: 12000, declared: [{ stepId: 's1', fieldIds: ['goal'] }] }, error: null };
  if (name === 'fusion_call_output_read') { const body = db.outputs.get(String(args.p_call_id)); return { data: body ? { body } : null, error: null }; }
  if (name === 'fusion_call_verdict') { const call = db.calls.find(c => c.callId === args.p_call_id)!; call.verdict = String(args.p_verdict); return { data: call.verdict, error: null }; }
  throw new Error('unexpected ' + name);
} } as unknown as SupabaseClient;
const opinion = (severity: string | null) => JSON.stringify({ issues: severity ? [{ location: '定位', problem: '太泛', suggestion: '写具体', severity }] : [] });
const revision = (value: string) => JSON.stringify({ body: `## 定位\n${value}\n## 结语\n原结语`,
  steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value, changed: true }] }],
  changeNotes: [{ section: '定位', wordingOnly: false, note: '更具体', fields: [{ stepId: 's1', fieldId: 'goal' }] }] });
function setup(script: (call: Call) => string | null) {
  const proposals: unknown[] = [];
  const executor = { run: vi.fn(async (_run: unknown, claimed: { id: string }, judge: (text: string) => string) => {
    const call = db.calls.find(c => c.callId === claimed.id)!;
    call.dispatched = true;
    const text = script(call);
    if (text === null) { call.verdict = 'no_delivery'; call.settled = true; return { state: 'judged', verdict: 'no_delivery' }; }
    db.outputs.set(call.callId, text);
    call.verdict = judge(text); call.settled = true;
    return { state: 'judged', verdict: call.verdict, text };
  }) };
  const flow = reviewFlow({ admin, actorId: randomUUID(), executor: executor as never,
    propose: async input => { proposals.push(input); return { revisionId: '00000000-0000-4000-8000-0000000000d1' }; } });
  const runAll = async () => {
    const step = await flow.continue(String(db.review!.reviewId));
    for (const call of step.calls) await flow.dispatch(String(db.review!.reviewId), call.callId);
    return step;
  };
  return { flow, proposals, runAll };
}

describe('review flow', () => {
  beforeEach(() => { db.review = null; db.calls = []; db.outputs.clear(); db.groups.clear(); });

  it('runs reviewers, the summary, round 2 without critical issues, and proposes the revision to R14', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标')
      : (db.review!.round === 1 ? opinion('critical') : opinion('minor')));
    const started = await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    expect(started.config).toMatchObject({ maxRounds: 2, reviewers: ids.reviewers, summary: ids.summary });
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual(ids.reviewers);
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual([ids.summary]);
    expect(db.review).toMatchObject({ round: 1, phase: 'summary' });
    expect((await t.runAll()).calls).toHaveLength(2);
    expect(db.review).toMatchObject({ round: 2, phase: 'review' });
    const end = await t.flow.continue(String(db.review!.reviewId));
    expect(end.review).toMatchObject({ state: 'completed', outcome: { kind: 'consensus', revisedInRound: 1 }, revisionId: '00000000-0000-4000-8000-0000000000d1' });
    expect(t.proposals).toEqual([expect.objectContaining({ body: '## 定位\n新目标\n## 结语\n原结语', fields: { s1: { goal: '新目标' } } })]);
    expect((await t.flow.continue(String(db.review!.reviewId))).calls).toEqual([]);
  });

  it('ends at once when round-1 reviewers find nothing; never proposes', async () => {
    const t = setup(() => opinion(null));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll();
    expect((await t.flow.continue(String(db.review!.reviewId))).review).toMatchObject({ state: 'completed', outcome: { kind: 'no_change' } });
    expect(t.proposals).toEqual([]);
  });

  it('ends incomplete without a summary when no reviewer gave a usable opinion', async () => {
    const t = setup(call => call.modelId === ids.reviewers[0] ? 'not json' : null);
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll();
    expect((await t.flow.continue(String(db.review!.reviewId))).review).toMatchObject({ state: 'incomplete', outcome: { kind: 'no_opinions' } });
    expect(db.calls.some(c => c.phase === 'fusion_summary')).toBe(false);
  });

  it('ends revision_failed when the summary fails the host check, and charges it nothing', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? JSON.stringify({ body: '## 定位\nx', steps: [], changeNotes: [] }) : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll();
    expect(db.calls.find(c => c.phase === 'fusion_summary')?.verdict).toBe('revision_invalid');
    expect((await t.flow.continue(String(db.review!.reviewId))).review).toMatchObject({ state: 'revision_failed' });
    expect(t.proposals).toEqual([]);
  });

  it('re-judges a saved body that never got a verdict before deciding (crash between save and verdict)', async () => {
    const t = setup(() => opinion(null));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.flow.continue(String(db.review!.reviewId));
    for (const call of db.calls) { call.dispatched = true; db.outputs.set(call.callId, 'malformed'); }
    await t.flow.continue(String(db.review!.reviewId));
    expect(db.calls.map(c => c.verdict)).toEqual(['format_invalid', 'format_invalid']);
    expect(db.review).toMatchObject({ state: 'incomplete' });
  });

  it('tells the summary model the exact length limit and the verbatim-copy rule the host check enforces (staging runs)', () => {
    const request = summaryRequest({ reviewer: 'r', summary: 's', rubric: 'b' },
      { report: original, materials: {}, sections, maxCharacters: 12000 }, [], [{ stepId: 's1', fieldIds: ['goal'] }], { s1: { goal: '旧目标' } });
    expect(request.instructions).toContain('不能超过 12000 个字符');
    expect(request.instructions).toContain('逐字照抄原文');
  });

  it('stop ends the review; continue then claims nothing', async () => {
    const t = setup(() => opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.flow.stop(String(db.review!.reviewId));
    expect(await t.flow.continue(String(db.review!.reviewId))).toMatchObject({ review: { state: 'stopped' }, calls: [] });
    await expect(t.flow.dispatch(String(db.review!.reviewId), randomUUID())).rejects.toThrow('FUSION_REVIEW_ENDED');
  });
});
