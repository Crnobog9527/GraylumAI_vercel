/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// In-memory stand-ins for the database record (0236/0256), admission and settings. The orchestration,
// prompts and host checks under test are the real ones.
type Call = { groupId: string; runId: string; callId: string; modelId: string; phase: string; dispatched: boolean;
  verdict: string | null; settled: boolean; state: string; dispatchedAt?: string; settledAt?: string };
const raceReservation = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const sourceBody = vi.hoisted(() => ({ value: null as string | null }));
const applyRefusal = vi.hoisted(() => ({ value: '' }));
const caps = vi.hoisted(() => [] as Array<{ opinion: number; summary: number }>);
const creditCaps = vi.hoisted(() => [] as Array<number | undefined>);
const usdCaps = vi.hoisted(() => [] as Array<string | undefined>);
const priceRise = vi.hoisted(() => ({ phase: '' }));
const requests = vi.hoisted(() => [] as Array<{ modelId: string; phase: string; input: string }>);
const clock = vi.hoisted(() => ({ t: Date.parse('2026-10-14T00:00:00Z'), next() { this.t += 1000; return new Date(this.t).toISOString(); } }));
const db = vi.hoisted(() => ({ review: null as Record<string, unknown> | null, calls: [] as Call[], outputs: new Map<string, string>(),
  savedAt: new Map<string, string>(),
  groups: new Map<string, { groupId: string; runs: Array<{ runId: string; index: number; phase: string; body: string; call: { model: string } }> }>() }));
const ids = { reviewers: ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'],
  summary: '00000000-0000-4000-8000-0000000000b1' };
vi.mock('./settings', () => ({ readFusionSettings: async () => ({ version: 1, compare: { enabled: false }, review: { enabled: true,
  reviewerModelIds: ids.reviewers, summaryModelId: ids.summary, skillId: '00000000-0000-4000-8000-0000000000c1', maxRounds: 2,
  opinionOutputTokens: 1000, summaryOutputTokens: 2000, maxBudgetUsd: '5', dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } } }) }));
vi.mock('../runtime/stagingPolicy', () => ({ loadStagingPolicy: async () => ({ creditsPerUsd: '100', callPolicies: [...ids.reviewers, ids.summary].map(modelId => ({ modelId,
  multiplier: '3', outputLimit: 8192, providerLimits: { providerSlug: 'x', contextTokens: 400000, promptUsdPerMillion: '0.1', completionUsdPerMillion: '0.1', requestUsd: '0' } })) }) }));
vi.mock('./reviewPrompts', async original => ({ ...(await original<typeof import('./reviewPrompts')>()),
  resolveReviewSkill: async () => ({ skillId: '00000000-0000-4000-8000-0000000000c1', revisionId: '00000000-0000-4000-8000-0000000000c2', packageHash: 'a'.repeat(64) }),
  readReviewSkill: async () => ({ reviewer: 'review', summary: 'summarize', rubric: 'rubric' }) }));
vi.mock('./admission', async original => ({ ...(await original<typeof import('./admission')>()),
  admitFusionGroup: async (input: { requestId: string; members: Array<{ modelId: string; phase: string; request: { input: string } }>;
    outputTokens: { opinion: number; summary: number }; maxCredits?: number; maxUsd?: string }) => {
    caps.push(input.outputTokens);
    creditCaps.push(input.maxCredits);
    usdCaps.push(input.maxUsd);
    // Prices rose after start: the real admission refuses a group above the frozen cap before freezing anything.
    if (input.members.some(m => m.phase === priceRise.phase)) throw new Error('FUSION_ESTIMATE_EXCEEDED');
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
    start: async (input: { config: unknown; requestId: string }) => { db.review = { reviewId: randomUUID(), requestId: input.requestId, state: 'running', round: 1, phase: 'review', attempt: 1,
      draftId: randomUUID(), sourceVersionId: randomUUID(), sourceSessionId: randomUUID(), versionHash: 'h',
      materials: { s1: { goal: { value: '旧目标', status: 'confirmed' } } }, materialsHash: 'a'.repeat(64), config: input.config, steps: [],
      outcome: null, revisionId: null, endedAt: null, adoption: null }; return view(); },
    read: async () => db.review ? view() : null,
    recordAdoption: async (_id: string, adoption: Record<string, unknown>) => {
      // A concurrent confirmation of the same request that reserved first (test hook).
      if (raceReservation.value && !db.review!.adoption) { db.review!.adoption = raceReservation.value; raceReservation.value = null; }
      const prior = db.review!.adoption as Record<string, unknown> | null;
      if (prior && prior.requestId !== adoption.requestId) throw new Error('FUSION_REVIEW_ADOPTED');
      if (prior && prior.state === 'reserved' && adoption.state === 'reserved') return view(); // replay, payload unchecked
      if (prior && prior.state === 'reserved' && adoption.state === 'recorded' && adoption.decision !== prior.decision
        && adoption.decision !== 'refused') throw new Error('FUSION_REVIEW_ADOPTED');
      if (!prior || (prior.state === 'reserved' && adoption.state === 'recorded')) db.review!.adoption = { ...adoption, at: clock.next() };
      return view();
    },
    replay: async (input: { requestId: string }) => db.review && db.review.requestId === input.requestId ? view() : null,
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
  if (name === 'fusion_review_preview') return { data: { reportBytes: 2000, materialsBytes: 500, reportSentBytes: 2200, materialsSentBytes: 600, fieldCount: 1 }, error: null };
  if (name === 'fusion_review_source') return { data: { body: sourceBody.value ?? original, sections, maxCharacters: 12000, declared: [{ stepId: 's1', fieldIds: ['goal'] }] }, error: null };
  if (name === 'fusion_call_output_read') { const body = db.outputs.get(String(args.p_call_id));
    return { data: body ? { body, savedAt: db.savedAt.get(String(args.p_call_id)) } : null, error: null }; }
  if (name === 'fusion_call_verdict') { const call = db.calls.find(c => c.callId === args.p_call_id)!; call.verdict = String(args.p_verdict); return { data: call.verdict, error: null }; }
  throw new Error('unexpected ' + name);
} } as unknown as SupabaseClient;
const opinion = (severity: string | null, verdict: 'keep' | 'change' = 'keep', debate: boolean | string[] = false) => JSON.stringify({
  decisions: DECISIONS.map(decision => ({ decision, strongestCase: '最强理由', strongestAlternative: '最强替代', verdict, basis: '依据' })),
  issues: severity ? [{ location: '定位', perspective: '目标受众：上班族', problem: '定位太泛，上班族看不出能得到什么具体的好处和结果',
    suggestion: '写清楚给上班族的具体好处，例如下班三十分钟就能做好一顿饭', severity }] : [],
  ...(debate ? { responses: (debate === true ? [] : debate).flatMap(seat => DECISIONS.map(decision =>
    ({ reviewer: seat, decision, strongestView: `${seat} 在这个决定上的最强观点`, stance: 'agree', reason: '有道理' }))) } : {}) });
const seatOf = (modelId: string) => String.fromCharCode(65 + ids.reviewers.indexOf(modelId));
const othersOf = (modelId: string) => ['A', 'B', 'C'].filter(seat => seat !== seatOf(modelId));
const revision = (value: string) => JSON.stringify({
  adjudication: [{ section: '定位', issue: '定位太泛', reviewers: ['A', 'B'], single: false, disputed: false, adopted: true,
    opinion: '定位要写清人群', reason: '原文确实没写清', fix: '点明给上班族省时间' }],
  body: `## 定位\n${value}\n## 结语\n原结语`,
  steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value, changed: true }] }],
  changeNotes: [{ section: '定位', wordingOnly: false, note: '更具体', fields: [{ stepId: 's1', fieldId: 'goal' }] }] });
function setup(script: (call: Call) => string | null, refuse?: string) {
  const proposals: unknown[] = [];
  const applied: unknown[] = [];
  const declined: unknown[] = [];
  const executor = { run: vi.fn(async (_run: unknown, claimed: { id: string }, judge: (text: string) => string) => {
    const call = db.calls.find(c => c.callId === claimed.id)!;
    call.dispatched = true; call.dispatchedAt = clock.next();
    const text = script(call);
    if (text === null) { call.verdict = 'no_delivery'; call.settled = true; call.settledAt = clock.next(); return { state: 'judged', verdict: 'no_delivery' }; }
    db.outputs.set(call.callId, text); db.savedAt.set(call.callId, clock.next());
    call.verdict = judge(text); call.settled = true; call.settledAt = clock.next();
    return { state: 'judged', verdict: call.verdict, text };
  }) };
  const flow = reviewFlow({ admin, actorId: randomUUID(), executor: executor as never,
    propose: async input => { if (refuse) throw new Error(refuse); proposals.push(input);
      return { revisionId: '00000000-0000-4000-8000-0000000000d1', diffHash: 'f'.repeat(64), diff: { changes: [], cascade: [] } }; },
    apply: async input => { if (applyRefusal.value) throw new Error(applyRefusal.value); applied.push(input);
      return { versionId: '00000000-0000-4000-8000-0000000000e1' }; },
    decline: async input => { declined.push(input); return null; } });
  const runAll = async () => {
    const step = await flow.continue(String(db.review!.reviewId));
    for (const call of step.calls) await flow.dispatch(String(db.review!.reviewId), call.callId);
    return step;
  };
  return { flow, proposals, applied, declined, runAll };
}

describe('review flow', () => {
  beforeEach(() => { db.review = null; db.calls = []; db.outputs.clear(); db.savedAt.clear(); db.groups.clear(); requests.length = 0; caps.length = 0; creditCaps.length = 0; usdCaps.length = 0; priceRise.phase = ''; });

  it('without a split: round 1, one summary, proposes the revision to R14, never re-reviewed by the panel', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    const started = await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    expect(started.config).toMatchObject({ maxRounds: 2, reviewers: ids.reviewers, summary: ids.summary });
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual(ids.reviewers);
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual([ids.summary]);
    expect(db.review).toMatchObject({ round: 1, phase: 'summary' });
    const end = await t.flow.continue(String(db.review!.reviewId));
    expect(end.review).toMatchObject({ state: 'completed',
      outcome: { kind: 'revised', debated: false, reviewedByPanel: false, awaitingChoice: true } });
    // Nothing reaches R14 until the user chooses section by section.
    expect(t.proposals).toEqual([]);
    expect((await t.flow.events(String(db.review!.reviewId))).ended).toBe(false);
    const choice = { reviewId: String(db.review!.reviewId), requestId: '00000000-0000-4000-8000-0000000000f1',
      choices: [{ section: '定位', use: 'revised' as const }] };
    // Step 1 only proposes and returns the diff (with cascade) for the user to see; nothing is applied yet.
    const proposed = await t.flow.adopt(choice);
    expect(proposed).toMatchObject({ state: 'proposed', diffHash: 'f'.repeat(64), diff: { cascade: [] }, adopted: ['定位'], kept: ['结语'] });
    expect(t.applied).toEqual([]);
    await expect(t.flow.confirmAdoption({ ...choice, expectedDiffHash: 'e'.repeat(64), decision: 'apply' })).rejects.toThrow('FUSION_ADOPTION_STALE');
    const adopted = await t.flow.confirmAdoption({ ...choice, expectedDiffHash: 'f'.repeat(64), decision: 'apply' });
    expect(adopted).toEqual({ state: 'recorded', versionId: '00000000-0000-4000-8000-0000000000e1', adopted: ['定位'], kept: ['结语'] });
    // Both steps propose the same R14 request (R14 replays it), so the user applies exactly the diff they saw.
    expect(new Set(t.proposals.map(p => JSON.stringify(p))).size).toBe(1);
    expect(t.proposals[0]).toEqual(expect.objectContaining({ body: '## 定位\n新目标\n## 结语\n原结语', fields: { s1: { goal: '新目标' } } }));
    expect(t.applied).toEqual([expect.objectContaining({ revisionId: '00000000-0000-4000-8000-0000000000d1', expectedDiffHash: 'f'.repeat(64) })]);
    const after = await t.flow.events(String(db.review!.reviewId));
    expect(after.ended).toBe(true);
    expect(after.events.at(-1)).toMatchObject({ type: 'adoption_done', adoptedSections: ['定位'] });
    // The summary saw the opinions as reviewers A, B, C, never model names.
    const summary = JSON.parse(requests.find(r => r.phase === 'fusion_summary')!.input);
    expect(summary.opinions.map((o: { reviewer: string }) => o.reviewer)).toEqual(['A', 'B', 'C']);
    expect(requests.find(r => r.phase === 'fusion_summary')!.input).not.toContain(ids.reviewers[0]);
    expect((await t.flow.continue(String(db.review!.reviewId))).calls).toEqual([]);
  });

  it('with a split over a key decision: a debate round where each reviewer sees the others, then one summary', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标')
      : db.review!.round === 2 ? opinion('major', 'change', othersOf(call.modelId))
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
    // Later groups are admitted with the output caps frozen at start, not the current settings.
    expect(caps.every(c => c.opinion === 1000 && c.summary === 2000)).toBe(true);
    // Progress events: derived from the record only, seats instead of model names, summaries clipped.
    const { events, ended } = await t.flow.events(String(db.review!.reviewId));
    expect(ended).toBe(false); // still waiting for the user's per-section choice
    const types = events.map(e => e.type);
    expect(types[0]).toBe('review_started');
    expect(types.filter(type => type === 'decision')).toHaveLength(24);
    expect(events.filter(e => e.type === 'disagreement').map(e => e.decision)).toEqual(['positioning', 'audience', 'platform', 'monetization']);
    expect(types.indexOf('disagreement')).toBeLessThan(types.indexOf('response'));
    expect(types.indexOf('response')).toBeLessThan(types.indexOf('summary_started'));
    expect(types.slice(-3)).toEqual(['adjudication', 'revision_ready_for_choice', 'review_ended']);
    expect(events.find(e => e.type === 'revision_ready_for_choice')).toMatchObject({ changedSectionTitles: ['定位'], changedSections: 1 });
    expect(events.find(e => e.type === 'response')).toMatchObject({ decision: 'positioning' });
    expect(events.filter(e => e.type === 'response')).toHaveLength(3 * 2 * 4);
    expect(events.find(e => e.type === 'issue')!.fix).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain(ids.reviewers[0]);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    // The owner's full record: complete reasoning per seat and the rulings by section, no model names.
    const detail = await t.flow.detail(String(db.review!.reviewId));
    expect(detail.seats.map(seat => [seat.seat, seat.rounds.map(r => r.status)])).toEqual([['A', ['usable', 'usable']],
      ['B', ['usable', 'usable']], ['C', ['usable', 'usable']]]);
    expect(detail.seats[1]!.rounds[0]!.issues![0]!.suggestion).toBe('写清楚给上班族的具体好处，例如下班三十分钟就能做好一顿饭');
    expect(detail.awaitingChoice).toBe(true);
    expect(detail.summary.sections).toEqual([expect.objectContaining({ section: '定位', changed: true, original: '原定位', revised: '新目标',
      fields: [{ stepId: 's1', fieldId: 'goal', before: '旧目标', after: '新目标' }], linkedSections: [],
      rulings: [expect.objectContaining({ opinion: '定位要写清人群', fix: '点明给上班族省时间', reviewers: ['A', 'B'] })] })]);
    expect(JSON.stringify(detail)).not.toContain(ids.reviewers[0]);
    // Stable: reading again gives the same ids in the same order.
    expect((await t.flow.events(String(db.review!.reviewId))).events.map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('judges a debate answer unusable unless it answers every other reviewer on every disputed decision exactly once', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标')
      : db.review!.round === 2 ? (call.modelId === ids.reviewers[1] ? opinion('major', 'change', ['A']) // misses C
        : call.modelId === ids.reviewers[2] ? opinion('major', 'change', ['A', 'B', 'C']) // answers itself
        : opinion('major', 'change', othersOf(call.modelId)))
      : opinion('major', call.modelId === ids.reviewers[0] ? 'change' : 'keep'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll();
    const second = db.calls.filter(c => (db.review!.steps as Array<{ groupId: string; round: number }>).find(s => s.groupId === c.groupId)?.round === 2
      && c.phase === 'fusion_review');
    expect(second.map(c => c.verdict)).toEqual(['usable', 'format_invalid', 'format_invalid']);
    // The debate request names exactly the pairs to answer.
    const toB = JSON.parse(requests.filter(r => r.phase === 'fusion_review')[4]!.input);
    expect(toB.respondTo).toHaveLength(2 * 4);
  });

  it('adoption: every changed section decided, wording-only needs a confirmation, keeping all calls no R14, once per review', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? JSON.stringify({ adjudication: [], body: '## 定位\n原定位。\n## 结语\n新结语',
      steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '旧目标', changed: false }] }],
      changeNotes: [{ section: '定位', wordingOnly: true, note: '标点', fields: [] }, { section: '结语', wordingOnly: true, note: '润色', fields: [] }] })
      : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId);
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'original' }] }))
      .rejects.toThrow('FUSION_ADOPTION_INCOMPLETE');
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'revised' }, { section: '结语', use: 'original' }] }))
      .rejects.toThrow('FUSION_ADOPTION_CONFIRM_REQUIRED');
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'original' }, { section: '定位', use: 'original' }] }))
      .rejects.toThrow('FUSION_ADOPTION_INVALID');
    const requestId = randomUUID();
    const kept = await t.flow.adopt({ reviewId, requestId, choices: [{ section: '定位', use: 'original' }, { section: '结语', use: 'original' }] });
    expect(kept).toEqual({ state: 'recorded', versionId: null, adopted: [], kept: ['定位', '结语'] });
    expect(t.proposals).toEqual([]);
    expect(await t.flow.adopt({ reviewId, requestId, choices: [{ section: '定位', use: 'original' }, { section: '结语', use: 'original' }] })).toEqual(kept);
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [] })).rejects.toThrow('FUSION_REVIEW_ADOPTED');
    expect(db.review!.adoption).toMatchObject({ requestId, kept: ['定位', '结语'], revisionId: null });
  });

  it('adoption: a confirmation reserves the choice before R14 applies, so a concurrent request cannot record something else', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId);
    const first = { reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'revised' as const }] };
    const order: string[] = [];
    const record = db.review!;
    const realApply = t.applied.push.bind(t.applied);
    t.applied.push = (...items: unknown[]) => { order.push(`apply:${(record.adoption as { state?: string } | null)?.state}`); return realApply(...items); };
    await t.flow.confirmAdoption({ ...first, expectedDiffHash: 'f'.repeat(64), decision: 'apply' });
    expect(order).toEqual(['apply:reserved']);
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'original' }] }))
      .rejects.toThrow('FUSION_REVIEW_ADOPTED');
  });

  it('a reservation that R14 refuses for good is finished as refused, so the review stops waiting', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId);
    applyRefusal.value = 'REPORT_REVISION_STALE';
    const confirm = { reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'revised' as const }],
      expectedDiffHash: 'f'.repeat(64), decision: 'apply' as const };
    await expect(t.flow.confirmAdoption(confirm)).rejects.toThrow('REPORT_REVISION_STALE');
    applyRefusal.value = '';
    expect(db.review!.adoption).toMatchObject({ state: 'recorded', decision: 'refused', refusal: 'REPORT_REVISION_STALE', adopted: [] });
    // A retry after a lost error response gets the same refusal, never an apparent success with everything kept.
    await expect(t.flow.confirmAdoption(confirm)).rejects.toThrow('REPORT_REVISION_STALE');
    await expect(t.flow.adopt(confirm)).rejects.toThrow('REPORT_REVISION_STALE');
  });

  it('a proposal decided through the R14 route first finishes the reservation instead of blocking it forever', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    applyRefusal.value = 'REPORT_REVISION_DECIDED';
    await expect(t.flow.confirmAdoption({ reviewId: String(db.review!.reviewId), requestId: randomUUID(),
      choices: [{ section: '定位', use: 'revised' }], expectedDiffHash: 'f'.repeat(64), decision: 'apply' })).rejects.toThrow('REPORT_REVISION_DECIDED');
    applyRefusal.value = '';
    expect(db.review!.adoption).toMatchObject({ state: 'recorded', decision: 'refused', refusal: 'REPORT_REVISION_DECIDED' });
  });

  it('a retry of a reserved confirmation cannot switch its decision', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId);
    const confirm = { reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'revised' as const }], expectedDiffHash: 'f'.repeat(64) };
    applyRefusal.value = 'REPORT_UNAVAILABLE';
    await expect(t.flow.confirmAdoption({ ...confirm, decision: 'apply' })).rejects.toThrow('REPORT_UNAVAILABLE');
    applyRefusal.value = '';
    expect(db.review!.adoption).toMatchObject({ state: 'reserved', decision: 'apply' });
    await expect(t.flow.confirmAdoption({ ...confirm, decision: 'decline' })).rejects.toThrow('FUSION_REVIEW_ADOPTED');
    // Different choices (even an extra, irrelevant confirmation) are refused before any R14 call.
    await expect(t.flow.confirmAdoption({ ...confirm, choices: [{ section: '定位', use: 'revised', confirmedNoFactChange: true }],
      decision: 'apply' })).rejects.toThrow('FUSION_REVIEW_ADOPTED');
    expect(t.applied).toEqual([]);
    expect(t.declined).toEqual([]);
    expect(await t.flow.confirmAdoption({ ...confirm, decision: 'apply' })).toMatchObject({ state: 'recorded', adopted: ['定位'] });
    expect((await t.flow.detail(reviewId)).awaitingChoice).toBe(false);
  });

  it('only the confirmation whose exact reservation was stored makes the R14 decision', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId), requestId = randomUUID();
    const choices = [{ section: '定位', use: 'revised' as const }];
    raceReservation.value = { state: 'reserved', requestId, decision: 'decline', choices, at: clock.next() };
    await expect(t.flow.confirmAdoption({ reviewId, requestId, choices, expectedDiffHash: 'f'.repeat(64), decision: 'apply' }))
      .rejects.toThrow('FUSION_REVIEW_ADOPTED');
    expect(t.applied).toEqual([]);
  });

  it('a report too large for a request ends the review before anything is claimed or charged', async () => {
    const t = setup(() => opinion('major'));
    // Escaped size counts: 100k quotes become 400k bytes once nested in the request JSON.
    sourceBody.value = `## 定位\n${'"'.repeat(100_000)}\n## 结语\n原结语`;
    const started = await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    sourceBody.value = null;
    expect(started).toMatchObject({ state: 'incomplete', outcome: { kind: 'input_too_large', phase: 'review' } });
    expect((await t.flow.continue(String(db.review!.reviewId))).calls).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('runs the size preflight before the first claim even when start never did (crash after the record was created)', async () => {
    const t = setup(() => opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    sourceBody.value = `## 定位\n${'"'.repeat(100_000)}\n## 结语\n原结语`;
    db.review!.state = 'paused'; // paused by the daily job while idle
    const end = await t.flow.continue(String(db.review!.reviewId));
    sourceBody.value = null;
    expect(end.review).toMatchObject({ state: 'incomplete', outcome: { kind: 'input_too_large' } });
    expect(db.calls).toEqual([]);
  });

  it('never holds more credits than the maximum shown at start: a pricier later step ends the review uncharged', async () => {
    const t = setup(() => opinion('major'));
    const started = await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    const cfg = started.config as { estimateCredits: number; phaseCredits: { review: number; debate: number; summary: number } };
    expect(cfg.estimateCredits).toBe(cfg.phaseCredits.review + cfg.phaseCredits.debate + cfg.phaseCredits.summary);
    const usd = (started.config as { phaseUsd: Record<string, string>; estimateUsd: string });
    expect(Number(usd.phaseUsd.review) + Number(usd.phaseUsd.debate) + Number(usd.phaseUsd.summary))
      .toBeGreaterThanOrEqual(Number(usd.estimateUsd));
    priceRise.phase = 'fusion_summary';
    await t.runAll();
    const end = await t.flow.continue(String(db.review!.reviewId));
    expect(creditCaps[0]).toBe(cfg.phaseCredits.review);
    expect(creditCaps.at(-1)).toBe(cfg.phaseCredits.summary);
    expect(usdCaps[0]).toBe(usd.phaseUsd.review);
    expect(usdCaps.at(-1)).toBe(usd.phaseUsd.summary);
    expect(end.review).toMatchObject({ state: 'incomplete', outcome: { kind: 'price_changed', phase: 'summary' } });
    expect(db.calls.some(call => call.phase === 'fusion_summary')).toBe(false);
  });

  it('trims the opinions a summary carries until its serialized request fits the byte cap', async () => {
    const long = '很长的理由'.repeat(390);
    const big = JSON.stringify({ decisions: DECISIONS.map(decision => ({ decision, strongestCase: long, strongestAlternative: long,
      verdict: 'keep' as const, basis: long })), issues: Array.from({ length: 50 }, () => ({ location: '定位', perspective: '目标受众',
      problem: long, suggestion: '改成' + long.slice(2), severity: 'minor' })) });
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : big);
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll();
    const summary = requests.find(r => r.phase === 'fusion_summary')!;
    const input = JSON.parse(summary.input);
    expect(input.opinions).toHaveLength(3);
    expect(input.opinions[0].issues).toEqual([]);
    expect(input.opinions[0].decisions[0].strongestCase).toBe('');
  });

  it('a partial panel never ends as no change: one usable reviewer that finds nothing still goes to the summary', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : call.modelId === ids.reviewers[0] ? opinion(null) : null);
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll();
    expect((await t.runAll()).calls.map(c => c.modelId)).toEqual([ids.summary]);
  });

  it('adoption: sections sharing a field are chosen together, and the merged text keeps the original for kept sections', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? JSON.stringify({ adjudication: [], body: '## 定位\n新定位\n## 结语\n新结语',
      steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '新目标', changed: true }] }],
      changeNotes: [{ section: '定位', wordingOnly: false, note: 'a', fields: [{ stepId: 's1', fieldId: 'goal' }] },
        { section: '结语', wordingOnly: false, note: 'b', fields: [{ stepId: 's1', fieldId: 'goal' }] }] }) : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll(); await t.flow.continue(String(db.review!.reviewId));
    const reviewId = String(db.review!.reviewId);
    await expect(t.flow.adopt({ reviewId, requestId: randomUUID(), choices: [{ section: '定位', use: 'revised' }, { section: '结语', use: 'original' }] }))
      .rejects.toThrow('FUSION_ADOPTION_LINKED');
    const detail = await t.flow.detail(reviewId);
    expect(detail.summary.sections.map(s => [s.section, s.linkedSections])).toEqual([['定位', ['结语']], ['结语', ['定位']]]);
  });

  it('shows judged results before financial settlement, and the usable summary attempt after a retry', async () => {
    const t = setup(call => call.phase === 'fusion_summary' ? revision('新目标') : opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.runAll(); await t.runAll();
    await t.flow.continue(String(db.review!.reviewId));
    for (const call of db.calls) { call.settled = false; delete call.settledAt; }
    // An earlier summary attempt that expired before dispatch, listed first.
    const usable = db.calls.find(c => c.phase === 'fusion_summary')!;
    db.calls.unshift({ ...usable, callId: randomUUID(), dispatched: false, verdict: 'no_delivery', settled: true, settledAt: clock.next() });
    const { events } = await t.flow.events(String(db.review!.reviewId));
    expect(events.filter(e => e.type === 'decision')).toHaveLength(12);
    expect(events.filter(e => e.type === 'adjudication')).toHaveLength(1);
    expect(events.map(e => e.type)).toContain('revision_ready_for_choice');
  });

  it('a retried start returns the existing review before any check that may have changed', async () => {
    const t = setup(() => opinion('major'));
    const requestId = randomUUID();
    const first = await t.flow.start({ requestId, draftId: randomUUID(), sourceVersionId: randomUUID() });
    const settings = await import('./settings');
    const spy = vi.spyOn(settings, 'readFusionSettings');
    const again = await t.flow.start({ requestId, draftId: randomUUID(), sourceVersionId: randomUUID() });
    expect(again.reviewId).toBe(first.reviewId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the event stream open while a saved body still awaits its verdict after a stop', async () => {
    const t = setup(() => opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.flow.continue(String(db.review!.reviewId));
    db.calls[0]!.dispatched = true;
    db.review!.endedAt = clock.next(); db.review!.state = 'stopped';
    expect((await t.flow.events(String(db.review!.reviewId))).ended).toBe(false);
    db.calls[0]!.verdict = 'no_delivery';
    expect((await t.flow.events(String(db.review!.reviewId))).ended).toBe(false); // judged, but no time for its event yet
    db.calls[0]!.settledAt = clock.next();
    expect((await t.flow.events(String(db.review!.reviewId))).ended).toBe(true);
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
    expect(request.instructions).toContain('不要提到你是哪个模型');
  });

  it('stop ends the review; continue then claims nothing', async () => {
    const t = setup(() => opinion('major'));
    await t.flow.start({ requestId: randomUUID(), draftId: randomUUID(), sourceVersionId: randomUUID() });
    await t.flow.stop(String(db.review!.reviewId));
    expect(await t.flow.continue(String(db.review!.reviewId))).toMatchObject({ review: { state: 'stopped' }, calls: [] });
    await expect(t.flow.dispatch(String(db.review!.reviewId), randomUUID())).rejects.toThrow('FUSION_REVIEW_ENDED');
  });
});
