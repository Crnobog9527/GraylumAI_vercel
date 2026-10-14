/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// In-memory stand-ins for the database record (0236/0256), admission and settings. The orchestration,
// prompts and host checks under test are the real ones.
type Call = { groupId: string; runId: string; callId: string; modelId: string; phase: string; dispatched: boolean;
  verdict: string | null; settled: boolean; state: string; dispatchedAt?: string; settledAt?: string };
const requests = vi.hoisted(() => [] as Array<{ modelId: string; phase: string; input: string }>);
const clock = vi.hoisted(() => ({ t: Date.parse('2026-10-14T00:00:00Z'), next() { this.t += 1000; return new Date(this.t).toISOString(); } }));
const db = vi.hoisted(() => ({ review: null as Record<string, unknown> | null, calls: [] as Call[], outputs: new Map<string, string>(),
  groups: new Map<string, { groupId: string; runs: Array<{ runId: string; index: number; phase: string; body: string; call: { model: string } }> }>() }));
const ids = { reviewers: ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'],
  summary: '00000000-0000-4000-8000-0000000000b1' };
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
    requests.push(...input.members.map(m => ({ modelId: m.modelId, phase: m.phase, input: m.request.input })));
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
      (db.review!.steps as unknown[]).push({ ...at, groupId, stepKey: key, claimedAt: clock.next() });
      for (const item of items) db.calls.push({ groupId, runId: item.runId, callId: randomUUID(), modelId: item.payload.model,
        phase: at.phase === 'review' ? 'fusion_review' : 'fusion_summary', dispatched: false, verdict: null, settled: false, state: 'prepared' });
      return { state: 'claimed', calls: [] };
    },
    advance: async (_id: string, _from: unknown, to: Record<string, unknown>) => {
      if (to.state === 'running') Object.assign(db.review!, { round: to.round, phase: to.phase, attempt: to.attempt });
      else Object.assign(db.review!, { state: to.state, outcome: to.outcome, revisionId: to.revisionId ?? null, endedAt: clock.next() });
      return view();
    },
    close: async (_id: string, state: string) => { db.review!.state = state; return view(); },
  }) };
});
import { reviewFlow } from './review';
import { summaryRequest } from './reviewPrompts';
import { DECISIONS } from './hostChecks';

const sections = ['定位', '结语'];
const original = '## 定位\n原定位\n## 结语\n原结语';
const admin = { rpc: async (name: string, args: Record<string, unknown>) => {
  if (name === 'fusion_review_preview') return { data: { reportBytes: 2000, materialsBytes: 500, fieldCount: 1 }, error: null };
  if (name === 'fusion_review_source') return { data: { body: original, sections, maxCharacters: 12000, declared: [{ stepId: 's1', fieldIds: ['goal'] }] }, error: null };
  if (name === 'fusion_call_output_read') { const body = db.outputs.get(String(args.p_call_id)); return { data: body ? { body } : null, error: null }; }
  if (name === 'fusion_call_verdict') { const call = db.calls.find(c => c.callId === args.p_call_id)!; call.verdict = String(args.p_verdict); return { data: call.verdict, error: null }; }
  throw new Error('unexpected ' + name);
} } as unknown as SupabaseClient;
const opinion = (severity: string | null, verdict: 'keep' | 'change' = 'keep', debate = false) => JSON.stringify({
  decisions: DECISIONS.map(decision => ({ decision, strongestCase: '最强理由', strongestAlternative: '最强替代', verdict, basis: '依据' })),
  issues: severity ? [{ location: '定位', perspective: '目标受众：上班族', problem: '定位太泛，上班族看不出能得到什么具体的好处和结果',
    suggestion: '写清楚给上班族的具体好处，例如下班三十分钟就能做好一顿饭', severity }] : [],
  ...(debate ? { responses: [{ reviewer: 'A', strongestView: '对方认为受众应该更窄', stance: 'agree', reason: '有道理' }] } : {}) });
const revision = (value: string) => JSON.stringify({
  adjudication: [{ issue: '定位太泛', reviewers: ['A', 'B'], single: false, adopted: true, reason: '原文确实没写清' }],
  body: `## 定位\n${value}\n## 结语\n原结语`,
  steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value, changed: true }] }],
  changeNotes: [{ section: '定位', wordingOnly: false, note: '更具体', fields: [{ stepId: 's1', fieldId: 'goal' }] }] });
function setup(script: (call: Call) => string | null) {
  const proposals: unknown[] = [];
  const executor = { run: vi.fn(async (_run: unknown, claimed: { id: string }, judge: (text: string) => string) => {
    const call = db.calls.find(c => c.callId === claimed.id)!;
    call.dispatched = true; call.dispatchedAt = clock.next();
    const text = script(call);
    if (text === null) { call.verdict = 'no_delivery'; call.settled = true; call.settledAt = clock.next(); return { state: 'judged', verdict: 'no_delivery' }; }
    db.outputs.set(call.callId, text);
    call.verdict = judge(text); call.settled = true; call.settledAt = clock.next();
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
  beforeEach(() => { db.review = null; db.calls = []; db.outputs.clear(); db.groups.clear(); requests.length = 0; });

  it('without a split: round 1, one summary, proposes the revision to R14, never re-reviewed by the panel', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    const started = await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    expect(started.config).toMatchObject({ maxRounds: 2, reviewers: ids.reviewers, summary: ids.summary });
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual(ids.reviewers);
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual([ids.summary]);
    expect(db.review).toMatchObject({ round: 1, phase: 'summary' });
    const end = await t.flow.continue(String(db.review!.reviewId));
    expect(end.review).toMatchObject({ state: 'completed', outcome: { kind: 'revised', debated: false, reviewedByPanel: false },
      revisionId: '00000000-0000-4000-8000-0000000000d1' });
    expect(t.proposals).toEqual([expect.objectContaining({ body: '## 定位\n新目标\n## 结语\n原结语', fields: { s1: { goal: '新目标' } } })]);
    // The summary saw the opinions as reviewers A, B, C, never model names.
    const summary = JSON.parse(requests.find(r => r.phase === 'fusion_summary')!.input);
    expect(summary.opinions.map((o: { reviewer: string }) => o.reviewer)).toEqual(['A', 'B', 'C']);
    expect(requests.find(r => r.phase === 'fusion_summary')!.input).not.toContain(ids.reviewers[0]);
    expect((await t.flow.continue(String(db.review!.reviewId))).calls).toEqual([]);
  });

  it('with a split over a key decision: a debate round where each reviewer sees the others, then one summary', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标')
      : db.review!.round === 2 ? opinion('major', 'change', true)
      : opinion('major', call.modelId === ids.reviewers[0] ? 'change' : 'keep'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll();
    const debate = await t.runAll();
    expect(db.review).toMatchObject({ round: 2, phase: 'review' });
    expect(debate.calls).toHaveLength(3);
    const toB = JSON.parse(requests.filter(r => r.phase === 'fusion_review')[4]!.input);
    expect(toB.mine).not.toBeNull();
    expect(toB.others.map((o: { reviewer: string }) => o.reviewer)).toEqual(['A', 'C']);
    await t.runAll();
    expect(db.review).toMatchObject({ round: 2, phase: 'summary' });
    expect((await t.flow.continue(String(db.review!.reviewId))).review).toMatchObject({ state: 'completed',
      outcome: { kind: 'revised', debated: true } });
    expect(t.proposals).toHaveLength(1);
    // Progress events: derived from the record only, seats instead of model names, summaries clipped.
    const { events, ended } = await t.flow.events(String(db.review!.reviewId));
    expect(ended).toBe(true);
    const types = events.map(e => e.type);
    expect(types[0]).toBe('review_started');
    expect(types.filter(type => type === 'decision')).toHaveLength(24);
    expect(events.filter(e => e.type === 'disagreement').map(e => e.decision)).toEqual(['positioning', 'audience', 'platform', 'monetization']);
    expect(types.indexOf('disagreement')).toBeLessThan(types.indexOf('response'));
    expect(types.indexOf('response')).toBeLessThan(types.indexOf('summary_started'));
    expect(types.slice(-3)).toEqual(['adjudication', 'revision_ready', 'review_ended']);
    expect(JSON.stringify(events)).not.toContain(ids.reviewers[0]);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    // Stable: reading again gives the same ids in the same order.
    expect((await t.flow.events(String(db.review!.reviewId))).events.map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('ends at once when every reviewer keeps every decision and finds nothing; never proposes', async () => {
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
    const t = setup(call => call.phase === 'fusion_summary' ? JSON.stringify({ adjudication: [], body: '## 定位\nx', steps: [], changeNotes: [] })
      : opinion('major'));
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
    expect(db.calls.map(c => c.verdict)).toEqual(['format_invalid', 'format_invalid', 'format_invalid']);
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
