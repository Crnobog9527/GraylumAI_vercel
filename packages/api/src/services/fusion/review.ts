/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../bill2/service';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionGroup, derivedUuid, replayFusionGroup, type FusionMember } from './admission';
import { fusionExecutor, type FusionBodyVerdict } from './executor';
import { checkRevision, hasCritical, parseOpinion, type DeclaredStep, type Opinion, type StepValues } from './hostChecks';
import { assertSnapshotSize } from './request';
import { estimateReview } from './reviewEstimate';
import { readReviewSkill, resolveReviewSkill, reviewerRequest, summaryRequest, type ReviewContext, type ReviewSkill } from './reviewPrompts';
import { ENDED_STATES, reviewRecord, type ReviewPosition, type ReviewView } from './reviewRecord';
import { readFusionSettings } from './settings';

type Executor = ReturnType<typeof fusionExecutor>;
const config = z.object({ estimateUsd: z.string(), maxRounds: z.number().int().min(1), reviewers: z.array(z.string().uuid()).min(1),
  summary: z.string().uuid(), skill: z.object({ skillId: z.string().uuid(), revisionId: z.string().uuid(),
    packageHash: z.string() }) }).passthrough();
const source = z.object({ body: z.string().min(1), sections: z.array(z.string()).min(1), maxCharacters: z.number().int().positive(),
  declared: z.array(z.object({ stepId: z.string(), fieldIds: z.array(z.string()) })) });
type Source = z.infer<typeof source>;
/** Revision accepted in a round: the base of the next round and, at the end, what R14 proposes. */
type Passed = { round: number; body: string; steps: StepValues; changeNotes: unknown; r14Fields: StepValues };
const ATTEMPTS = 3;
const stepKey = (at: ReviewPosition) => `review:${at.round}:${at.phase}:${at.attempt}`;

/** FUSION-REVIEW §2.1/§2.2 orchestration over the review record (0236): the server decides each next step;
 * every model call is its own browser request (dispatch). Billing, rate limits and holds stay with the
 * executor and the database; this module only decides what to claim and how each result is judged. */
export function reviewFlow(deps: { admin: SupabaseClient; actorId: string;
  /** Needed to dispatch; recovery (re-judging only) passes none. */
  executor?: Executor;
  env?: Record<string, string | undefined>;
  /** R14 reportRevisionPropose with the user's own client (it requires the user's verified identity). */
  propose?: (input: { draftId: string; requestId: string; sourceVersionId: string; body: string; fields: StepValues }) =>
    Promise<{ revisionId: string }> }) {
  const { admin, actorId } = deps;
  const env = deps.env ?? process.env;
  const record = reviewRecord(admin, actorId);
  const readSource = async (reviewId: string): Promise<Source> => {
    const result = await admin.rpc('fusion_review_source', { p_actor_id: actorId, p_review_id: reviewId });
    if (result.error) throw new Error('FUSION_REVIEW_STALE');
    return source.parse(result.data);
  };
  const frozenValues = (view: ReviewView): StepValues => Object.fromEntries(Object.entries(view.materials).map(([stepId, fields]) =>
    [stepId, Object.fromEntries(Object.entries(fields).map(([fieldId, field]) => [fieldId, typeof field.value === 'string' ? field.value : '']))]));
  const outputOf = async (callId: string) => {
    const result = await admin.rpc('fusion_call_output_read', { p_actor_id: actorId, p_call_id: callId });
    if (result.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    return (result.data as { body: string } | null)?.body ?? null;
  };
  /** Calls of one round/phase over all attempts, with the step they were claimed in. */
  const callsAt = (view: ReviewView, round: number, phase: string) => {
    const groups = new Set(view.steps.filter(step => step.round === round && step.phase === phase).map(step => step.groupId));
    return view.calls.filter(call => groups.has(call.groupId));
  };
  /** The revision that passed in the latest summary up to `round` (deterministically re-checked). */
  async function passedRevision(view: ReviewView, src: Source, round: number): Promise<Passed | null> {
    for (let r = round; r >= 1; r--) {
      const call = callsAt(view, r, 'summary').find(c => ['usable', 'unjudged_saved'].includes(String(c.verdict)));
      if (!call) continue;
      const text = await outputOf(call.callId);
      const before = r > 1 ? await passedRevision(view, src, r - 1) : null;
      const result = text ? checkRevision(text, revisionInput(view, src, before)) : null;
      if (result?.ok) return { round: r, body: result.body, steps: result.steps, changeNotes: result.changeNotes, r14Fields: result.r14Fields };
      return null;
    }
    return null;
  }
  const revisionInput = (view: ReviewView, src: Source, before: Passed | null) => ({
    previousBody: before?.body ?? src.body, previousSteps: before?.steps ?? frozenValues(view), frozenSteps: frozenValues(view),
    declared: src.declared as DeclaredStep[], sections: src.sections, maxCharacters: src.maxCharacters });
  /** The frozen host check for one saved body (also used by recovery, §3.3). */
  async function judgeText(view: ReviewView, src: Source, phase: string, round: number, text: string): Promise<FusionBodyVerdict> {
    if (phase === 'fusion_review') return parseOpinion(text) ? 'usable' : 'format_invalid';
    const before = round > 1 ? await passedRevision(view, src, round - 1) : null;
    return checkRevision(text, revisionInput(view, src, before)).ok ? 'usable' : 'revision_invalid';
  }
  /** Saved but never judged (a crash between save and verdict): judge again with the frozen check. */
  async function rejudge(view: ReviewView, src: Source) {
    for (const call of view.calls.filter(c => c.verdict === null && c.dispatched)) {
      const text = await outputOf(call.callId);
      if (!text) continue;
      const step = view.steps.find(s => s.groupId === call.groupId)!;
      const verdict = await judgeText(view, src, call.phase, step.round, text);
      const result = await admin.rpc('fusion_call_verdict', { p_actor_id: actorId, p_call_id: call.callId, p_verdict: verdict });
      if (result.error && !/FUSION_VERDICT_IMMUTABLE/.test(String(result.error.message))) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    }
  }
  async function contextOf(view: ReviewView, src: Source, round: number): Promise<{ context: ReviewContext; current: StepValues }> {
    const before = round > 1 ? await passedRevision(view, src, round - 1) : null;
    return { current: before?.steps ?? frozenValues(view), context: { report: before?.body ?? src.body, materials: view.materials,
      sections: src.sections, maxCharacters: src.maxCharacters, ...(before ? { previous: { steps: before.steps, changeNotes: before.changeNotes } } : {}) } };
  }
  /** Admits and claims the models of the current position that have no finished call yet. */
  async function claimStep(view: ReviewView, src: Source, at: ReviewPosition, models: string[]) {
    const cfg = config.parse(view.config);
    const skill = await readReviewSkill(admin, cfg.skill as ReviewSkill);
    const { context, current } = await contextOf(view, src, at.round);
    assertSnapshotSize(context.report, context.materials);
    let members: FusionMember[];
    if (at.phase === 'review') members = models.map(modelId => ({ modelId, phase: 'fusion_review', request: reviewerRequest(skill, context) }));
    else {
      const opinions: Opinion[] = [];
      for (const call of callsAt(view, at.round, 'review').filter(c => ['usable', 'unjudged_saved'].includes(String(c.verdict)))) {
        const parsed = parseOpinion((await outputOf(call.callId)) ?? '');
        if (parsed) opinions.push(parsed);
      }
      members = [{ modelId: cfg.summary, phase: 'fusion_summary', request: summaryRequest(skill, context, opinions, src.declared, current) }];
    }
    const requestId = derivedUuid(`${view.reviewId}:${stepKey(at)}`);
    const group = await admitFusionGroup({ admin, actorId, requestId, sourceSessionId: view.sourceSessionId, members, env });
    return record.claim(view.reviewId, at, group.groupId, group.runs.map(run => ({ runId: run.runId, payload: run.call })));
  }
  async function finish(view: ReviewView, state: 'completed' | 'incomplete' | 'revision_failed', outcome: Record<string, unknown>,
    revision: Passed | null) {
    let revisionId: string | undefined;
    if (revision) {
      if (!deps.propose) throw new Error('FUSION_REVIEW_UNAVAILABLE');
      ({ revisionId } = await deps.propose({ draftId: view.draftId, requestId: derivedUuid(`${view.reviewId}:propose`),
        sourceVersionId: view.sourceVersionId, body: revision.body, fields: revision.r14Fields }));
    }
    const at = { round: view.round, phase: view.phase, attempt: view.attempt };
    return record.advance(view.reviewId, at, { state, outcome: { ...outcome, ...(revision ? { revisedInRound: revision.round } : {}) },
      ...(revisionId ? { revisionId } : {}) });
  }
  const done = (call: ReviewView['calls'][number]) => call.verdict !== null;

  return {
    /** Freezes settings, Skill revision and estimate; refuses a review that cannot fit or exceeds the budget. */
    async start(input: { requestId: string; draftId: string; sourceVersionId: string }) {
      const settings = await readFusionSettings(admin);
      if (!settings.review.enabled) throw new Error('FUSION_REVIEW_DISABLED');
      if (!settings.review.skillId || !settings.review.summaryModelId || !settings.review.maxBudgetUsd) throw new Error('FUSION_REVIEW_INCOMPLETE');
      const skill = await resolveReviewSkill(admin, settings.review.skillId);
      const text = await readReviewSkill(admin, skill);
      const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
      const sizes = await admin.rpc('fusion_review_preview', { p_actor_id: actorId, p_draft_id: input.draftId,
        p_source_version_id: input.sourceVersionId });
      if (sizes.error) throw new Error('FUSION_REVIEW_STALE');
      const preview = z.object({ reportBytes: z.number(), materialsBytes: z.number(), fieldCount: z.number() }).parse(sizes.data);
      const { rounds, estimateUsd } = estimateReview({ quotes: window.callPolicies, reviewers: settings.review.reviewerModelIds,
        summary: settings.review.summaryModelId, maxRounds: settings.review.maxRounds, maxBudgetUsd: settings.review.maxBudgetUsd,
        opinionTokens: settings.review.opinionOutputTokens, summaryTokens: settings.review.summaryOutputTokens, fieldCount: preview.fieldCount,
        snapshotBytes: preview.reportBytes + preview.materialsBytes,
        instructionBytes: { reviewer: Buffer.byteLength(text.reviewer + text.rubric) + 2048, summary: Buffer.byteLength(text.summary + text.rubric) + 2048 } });
      return record.start({ requestId: input.requestId, draftId: input.draftId, sourceVersionId: input.sourceVersionId,
        config: { estimateUsd, maxRounds: rounds, reviewers: settings.review.reviewerModelIds, summary: settings.review.summaryModelId,
          opinionTokens: settings.review.opinionOutputTokens, summaryTokens: settings.review.summaryOutputTokens, skill } });
    },
    /** Idempotent: re-judges saved bodies, claims the current step once, or decides the next step / end state. */
    async continue(reviewId: string): Promise<{ review: ReviewView; calls: ReviewView['calls']; waiting?: 'credits' | 'calls' }> {
      let view = await record.read(reviewId);
      if (!view) throw new Error('FUSION_REVIEW_DENIED');
      if (ENDED_STATES.has(view.state)) return { review: view, calls: [] };
      const src = await readSource(reviewId);
      await rejudge(view, src);
      view = (await record.read(reviewId))!;
      const cfg = config.parse(view.config);
      for (let guard = 0; guard < 8; guard++) {
        if (ENDED_STATES.has(view.state)) return { review: view, calls: [] };
        const at: ReviewPosition = { round: view.round, phase: view.phase, attempt: view.attempt };
        const here = callsAt(view, at.round, at.phase === 'review' ? 'review' : 'summary');
        const current = view.calls.filter(call => view!.steps.some(s => s.groupId === call.groupId && s.stepKey === stepKey(at)));
        const models = at.phase === 'review' ? cfg.reviewers : [cfg.summary];
        if (!current.length) {
          const pending = models.filter(id => !here.some(call => done(call) && !(call.verdict === 'no_delivery' && !call.dispatched)
            && call.modelId === id));
          const claimed = await claimStep(view, src, at, pending.length ? pending : models);
          view = (await record.read(reviewId))!;
          if (claimed.state === 'waiting_credits') return { review: view, calls: [], waiting: 'credits' };
          return { review: view, calls: view.calls.filter(call => !done(call)) };
        }
        if (current.some(call => !done(call))) return { review: view, calls: current.filter(call => !done(call)), waiting: 'calls' };
        // Calls expired before dispatch are claimed again in a new attempt (§2.1 补领), bounded.
        if (current.some(call => call.verdict === 'no_delivery' && !call.dispatched) && at.attempt < ATTEMPTS) {
          view = await record.advance(reviewId, at, { state: 'running', round: at.round, phase: at.phase, attempt: at.attempt + 1 });
          continue;
        }
        const usable = here.filter(call => ['usable', 'unjudged_saved'].includes(String(call.verdict)));
        if (at.phase === 'review') {
          const opinions: Opinion[] = [];
          for (const call of usable) { const parsed = parseOpinion((await outputOf(call.callId)) ?? ''); if (parsed) opinions.push(parsed); }
          const previous = at.round > 1 ? await passedRevision(view, src, at.round - 1) : null;
          if (!opinions.length) {
            view = await finish(view, 'incomplete', { kind: 'no_opinions' }, previous);
          } else if (at.round === 1 && opinions.every(opinion => !opinion.issues.length)) {
            view = await finish(view, 'completed', { kind: 'no_change' }, null);
          } else if (at.round > 1 && !hasCritical(opinions)) {
            view = await finish(view, 'completed', { kind: 'consensus' }, previous);
          } else {
            view = await record.advance(reviewId, at, { state: 'running', round: at.round, phase: 'summary', attempt: 1 });
          }
          continue;
        }
        const passed = usable.length ? await passedRevision(view, src, at.round) : null;
        if (!passed || passed.round !== at.round) {
          view = await finish(view, 'revision_failed', { kind: 'revision_failed' }, at.round > 1 ? await passedRevision(view, src, at.round - 1) : null);
        } else if (at.round >= cfg.maxRounds) {
          view = await finish(view, 'completed', { kind: 'round_limit', reviewedByPanel: false }, passed);
        } else {
          view = await record.advance(reviewId, at, { state: 'running', round: at.round + 1, phase: 'review', attempt: 1 });
        }
      }
      return { review: view, calls: [] };
    },
    /** One model call per browser request: dispatch, stream, save, judge, settle. */
    async dispatch(reviewId: string, callId: string, onChunk?: (chunk: string) => void) {
      const view = await record.read(reviewId);
      if (!view || ENDED_STATES.has(view.state)) throw new Error('FUSION_REVIEW_ENDED');
      const call = view.calls.find(c => c.callId === callId);
      const step = call && view.steps.find(s => s.groupId === call.groupId);
      if (!call || !step || call.dispatched || call.verdict !== null) throw new Error('FUSION_REVIEW_STEP_CONFLICT');
      const group = await replayFusionGroup(admin, actorId, derivedUuid(`${reviewId}:${step.stepKey}`), view.sourceSessionId);
      const run = group?.runs.find(r => r.runId === call.runId);
      if (!run) throw new Error('FUSION_REVIEW_STEP_CONFLICT');
      const src = await readSource(reviewId);
      // The frozen check is synchronous once its inputs (the previous passed revision) are resolved.
      const before = run.phase === 'fusion_summary' && step.round > 1 ? await passedRevision(view, src, step.round - 1) : null;
      const judge = (text: string): FusionBodyVerdict => run.phase === 'fusion_review'
        ? (parseOpinion(text) ? 'usable' : 'format_invalid')
        : (checkRevision(text, revisionInput(view, src, before)).ok ? 'usable' : 'revision_invalid');
      if (!deps.executor) throw new Error('FUSION_REVIEW_UNAVAILABLE');
      return deps.executor.run(run, { runId: call.runId, id: callId, state: call.state, fresh: false }, judge, onChunk);
    },
    stop: (reviewId: string) => record.close(reviewId, 'stopped'),
    end: (reviewId: string) => record.close(reviewId, 'interrupted'),
    rejudge: async (reviewId: string) => {
      const view = await record.read(reviewId);
      if (view) await rejudge(view, await readSource(reviewId));
    },
  };
}
