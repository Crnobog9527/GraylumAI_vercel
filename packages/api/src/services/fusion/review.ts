/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../bill2/service';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionGroup, derivedUuid, replayFusionGroup, type FusionMember } from './admission';
import { fusionExecutor, type FusionBodyVerdict } from './executor';
import { checkRevision, DECISIONS, disputedDecisions, hasDisagreement, parseOpinion, type DeclaredStep, type Opinion, type StepValues } from './hostChecks';
import { assertSnapshotSize, fusionRequestBytes, type FusionRequest } from './request';
import { PAYG_PROFILE_MAX_BYTES } from '../runtime/paygHostPolicy';
import { estimateReview } from './reviewEstimate';
import { debateRequest, readReviewSkill, resolveReviewSkill, reviewerLabel, reviewerRequest, summaryRequest, type ReviewContext,
  type ReviewSkill } from './reviewPrompts';
import { reviewDetail, reviewEvents } from './reviewEvents';
import { adoptionChoices, adoptionSections, applyChoices, type AdoptionChoice } from './reviewAdoption';
import { ENDED_STATES, reviewRecord, type ReviewPosition, type ReviewView } from './reviewRecord';
import { readFusionSettings } from './settings';

type Executor = ReturnType<typeof fusionExecutor>;
const config = z.object({ estimateUsd: z.string(), maxRounds: z.number().int().min(1), reviewers: z.array(z.string().uuid()).min(1),
  opinionTokens: z.number().int().positive(), summaryTokens: z.number().int().positive(),
  summary: z.string().uuid(), skill: z.object({ skillId: z.string().uuid(), revisionId: z.string().uuid(),
    packageHash: z.string() }) }).passthrough();
const source = z.object({ body: z.string().min(1), sections: z.array(z.string()).min(1), maxCharacters: z.number().int().positive(),
  declared: z.array(z.object({ stepId: z.string(), fieldIds: z.array(z.string()) })) });
type Source = z.infer<typeof source>;
/** The summary's revision that passed the host check: what R14 proposes. */
type Passed = { round: number; body: string; steps: StepValues; changeNotes: unknown; changedSections: string[]; r14Fields: StepValues };
const ATTEMPTS = 3;
/** JSON with sorted keys: the database stores choices as jsonb, which does not keep key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);
/** R14 refusals that retrying cannot fix; transient ones (REPORT_UNAVAILABLE, auth) are retried by the client. */
// REPORT_REVISION_DECIDED is not here: it can mean this very decision already committed.
const PERMANENT_REFUSALS = new Set(['REPORT_REVISION_STALE', 'REPORT_SOURCE_CONFLICT', 'CONTENT_ERASED',
  'REPORT_NOT_COMPLETE', 'REPORT_REVISION_UNSUPPORTED']);
const stepKey = (at: ReviewPosition) => `review:${at.round}:${at.phase}:${at.attempt}`;

/** FUSION-REVIEW §2.1/§2.2 orchestration over the review record (0236): the server decides each next step;
 * every model call is its own browser request (dispatch). Billing, rate limits and holds stay with the
 * executor and the database; this module only decides what to claim and how each result is judged. */
export function reviewFlow(deps: { admin: SupabaseClient; actorId: string;
  /** Needed to dispatch; recovery (re-judging only) passes none. */
  executor?: Executor;
  env?: Record<string, string | undefined>;
  /** R14 reportRevisionPropose / Apply with the user's own client (they require the user's verified identity). */
  propose?: (input: { draftId: string; requestId: string; sourceVersionId: string; body: string; fields: StepValues }) =>
    Promise<{ revisionId: string; diffHash: string; diff: unknown }>;
  apply?: (input: { draftId: string; revisionId: string; requestId: string; expectedDiffHash: string }) =>
    Promise<{ versionId: string | null }>;
  decline?: (input: { draftId: string; revisionId: string; requestId: string }) => Promise<unknown> }) {
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
  /** The summary revision that passed (one summary per review, after round 1 or the debate round). */
  async function passedRevision(view: ReviewView, src: Source): Promise<Passed | null> {
    const call = view.calls.find(c => c.phase === 'fusion_summary' && ['usable', 'unjudged_saved'].includes(String(c.verdict)));
    const text = call ? await outputOf(call.callId) : null;
    const result = text ? checkRevision(text, revisionInput(view, src)) : null;
    if (!result?.ok) return null;
    const round = view.steps.find(step => step.groupId === call!.groupId)?.round ?? 1;
    return { round, body: result.body, steps: result.steps, changeNotes: result.changeNotes, changedSections: result.changedSections,
      r14Fields: result.r14Fields };
  }
  const revisionInput = (view: ReviewView, src: Source) => ({
    previousBody: src.body, previousSteps: frozenValues(view), frozenSteps: frozenValues(view),
    declared: src.declared as DeclaredStep[], sections: src.sections, maxCharacters: src.maxCharacters });
  /** Rules for one reviewer's answer: in the debate round it must answer every other reviewer with a usable
   * round-1 opinion on every disputed decision, exactly once (derived from the saved round-1 opinions only). */
  async function opinionRules(view: ReviewView, src: Source, round: number, modelId: string | null) {
    if (round === 1) return { sections: src.sections };
    const cfg = config.parse(view.config);
    const first = await opinionsOf(view, src, 1);
    const self = cfg.reviewers.indexOf(modelId ?? '');
    const disputed = disputedDecisions([...first.values()]);
    const responses = [...first.keys()].filter(index => index !== self)
      .flatMap(index => disputed.map(decision => ({ reviewer: reviewerLabel(index), decision })));
    return { sections: src.sections, debate: true, responses };
  }
  /** Usable opinions of one review round, keyed by the reviewer's position in the frozen panel. */
  async function opinionsOf(view: ReviewView, src: Source, round: number): Promise<Map<number, Opinion>> {
    const cfg = config.parse(view.config);
    const found = new Map<number, Opinion>();
    for (const call of callsAt(view, round, 'review').filter(c => ['usable', 'unjudged_saved'].includes(String(c.verdict)))) {
      const parsed = parseOpinion((await outputOf(call.callId)) ?? '', await opinionRules(view, src, round, call.modelId ?? null));
      const index = cfg.reviewers.indexOf(call.modelId ?? '');
      if (parsed && index >= 0) found.set(index, parsed);
    }
    return found;
  }
  /** What the summary sees: each reviewer's debate answer when it gave one, else its round-1 opinion. */
  async function finalOpinions(view: ReviewView, src: Source) {
    const first = await opinionsOf(view, src, 1);
    const second = view.round > 1 || view.steps.some(step => step.round > 1) ? await opinionsOf(view, src, 2) : new Map<number, Opinion>();
    const indexes = [...new Set([...first.keys(), ...second.keys()])].sort((a, b) => a - b);
    return indexes.map(index => ({ reviewer: reviewerLabel(index), opinion: (second.get(index) ?? first.get(index))! }));
  }
  /** The frozen host check for one saved body (also used by recovery, §3.3). */
  async function judgeText(view: ReviewView, src: Source, call: ReviewView['calls'][number], round: number, text: string): Promise<FusionBodyVerdict> {
    if (call.phase === 'fusion_review') return parseOpinion(text, await opinionRules(view, src, round, call.modelId ?? null)) ? 'usable' : 'format_invalid';
    return checkRevision(text, revisionInput(view, src)).ok ? 'usable' : 'revision_invalid';
  }
  /** Saved but never judged (a crash between save and verdict): judge again with the frozen check. */
  async function rejudge(view: ReviewView, src: Source) {
    for (const call of view.calls.filter(c => c.verdict === null && c.dispatched)) {
      const text = await outputOf(call.callId);
      if (!text) continue;
      const step = view.steps.find(s => s.groupId === call.groupId)!;
      const verdict = await judgeText(view, src, call, step.round, text);
      const result = await admin.rpc('fusion_call_verdict', { p_actor_id: actorId, p_call_id: call.callId, p_verdict: verdict });
      if (result.error && !/FUSION_VERDICT_IMMUTABLE/.test(String(result.error.message))) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    }
  }
  const contextOf = (view: ReviewView, src: Source): ReviewContext => ({ report: src.body, materials: view.materials,
    sections: src.sections, maxCharacters: src.maxCharacters });
  /** Round 1 as sent, and the summary at its deepest trimming (verdicts only, which claimStep can always fall back to). */
  function fitsWhenSent(view: ReviewView, src: Source, skill: Awaited<ReturnType<typeof readReviewSkill>>) {
    const context = contextOf(view, src);
    const cfg = config.parse(view.config);
    const verdictsOnly = (index: number) => ({ reviewer: reviewerLabel(index), opinion: {
      decisions: DECISIONS.map(decision => ({ decision, strongestCase: '', strongestAlternative: '', verdict: 'change' as const, basis: '' })),
      issues: [], dropped: 0 } });
    return fusionRequestBytes(reviewerRequest(skill, context)) <= PAYG_PROFILE_MAX_BYTES
      && fusionRequestBytes(summaryRequest(skill, context, cfg.reviewers.map((_, i) => verdictsOnly(i)), src.declared, frozenValues(view)))
        <= PAYG_PROFILE_MAX_BYTES;
  }
  /** The least trimming that fits the byte cap: 0 = full opinions; 1 = without replies and reasoning text; 2 = also only
   * critical and major issues; 3 = also no issues (the key-decision verdicts stay). */
  function fitted(build: (level: number) => FusionRequest): FusionRequest {
    for (let level = 0; level < 3; level++) {
      const request = build(level);
      if (fusionRequestBytes(request) <= PAYG_PROFILE_MAX_BYTES) return request;
    }
    return build(3);
  }
  const trimmed = (opinion: Opinion | null, level: number): Opinion | null => !opinion || level === 0 ? opinion : {
    decisions: opinion.decisions.map(d => level >= 1 ? { ...d, strongestCase: '', strongestAlternative: '', basis: '' } : d),
    issues: level >= 3 ? [] : level >= 2 ? opinion.issues.filter(i => i.severity !== 'minor') : opinion.issues,
    dropped: opinion.dropped };
  /** Admits and claims the models of the current position that have no finished call yet. */
  async function claimStep(view: ReviewView, src: Source, at: ReviewPosition, models: string[]) {
    const cfg = config.parse(view.config);
    const skill = await readReviewSkill(admin, cfg.skill as ReviewSkill);
    const context = contextOf(view, src);
    assertSnapshotSize(context.report, context.materials);
    let members: FusionMember[];
    if (at.phase === 'review' && at.round === 1) {
      members = models.map(modelId => ({ modelId, phase: 'fusion_review', request: reviewerRequest(skill, context) }));
    } else if (at.phase === 'review') {
      const first = await opinionsOf(view, src, 1);
      members = models.map(modelId => {
        const index = cfg.reviewers.indexOf(modelId);
        const others = [...first].filter(([other]) => other !== index).map(([other, opinion]) => ({ reviewer: reviewerLabel(other), opinion }));
        return { modelId, phase: 'fusion_review' as const, request: fitted(level => debateRequest(skill, context,
          trimmed(first.get(index) ?? null, level), others.map(o => ({ ...o, opinion: trimmed(o.opinion, level)! })),
          disputedDecisions([...first.values()]))) };
      });
    } else {
      const opinions = await finalOpinions(view, src);
      members = [{ modelId: cfg.summary, phase: 'fusion_summary', request: fitted(level => summaryRequest(skill, context,
        opinions.map(o => ({ ...o, opinion: trimmed(o.opinion, level)! })), src.declared, frozenValues(view))) }];
    }
    // Every request must fit the per-call billing byte cap as actually serialized (#962 review); a step that cannot fit
    // even fully trimmed is never claimed.
    if (members.some(member => fusionRequestBytes(member.request) > PAYG_PROFILE_MAX_BYTES)) throw new Error('FUSION_INPUT_TOO_LARGE');
    const requestId = derivedUuid(`${view.reviewId}:${stepKey(at)}`);
    const group = await admitFusionGroup({ admin, actorId, requestId, sourceSessionId: view.sourceSessionId, members, env,
      outputTokens: { opinion: cfg.opinionTokens, summary: cfg.summaryTokens } });
    return record.claim(view.reviewId, at, group.groupId, group.runs.map(run => ({ runId: run.runId, payload: run.call })));
  }
  async function finish(view: ReviewView, state: 'completed' | 'incomplete' | 'revision_failed', outcome: Record<string, unknown>) {
    const at = { round: view.round, phase: view.phase, attempt: view.attempt };
    return record.advance(view.reviewId, at, { state, outcome });
  }
  /** The per-section view of a passed revision, against the frozen reviewed version (§2.2, Owner 2026-10-14). */
  async function adoptionPlan(view: ReviewView, src: Source) {
    const passed = await passedRevision(view, src);
    if (!passed) return null;
    const notes = passed.changeNotes as Array<{ section: string; wordingOnly: boolean; fields: Array<{ stepId: string; fieldId: string }> }>;
    return { passed, sections: adoptionSections({ originalBody: src.body, revisedBody: passed.body, sections: src.sections,
      changedSections: passed.changedSections, changeNotes: notes, frozen: frozenValues(view), revisedSteps: passed.steps }) };
  }
  /** The validated choices of a revised review and the merged text they produce (both steps recompute it). */
  async function adoptionInput(input: { reviewId: string; requestId: string; choices: AdoptionChoice[] }) {
    const choices = adoptionChoices.parse(input.choices);
    const view = await record.read(input.reviewId);
    if (!view) throw new Error('FUSION_REVIEW_DENIED');
    const prior = view.adoption as { requestId?: string } | null | undefined;
    if (prior && prior.requestId !== input.requestId) throw new Error('FUSION_REVIEW_ADOPTED');
    if (view.state !== 'completed' || (view.outcome as { kind?: string } | null)?.kind !== 'revised') throw new Error('FUSION_REVIEW_INVALID');
    // The original text comes from the frozen version (its hash is checked); the revision is re-checked.
    const src = await readSource(input.reviewId);
    const plan = await adoptionPlan(view, src);
    if (!plan) throw new Error('FUSION_REVIEW_INVALID');
    return { view, merged: applyChoices({ originalBody: src.body, revisedBody: plan.passed.body, plan: plan.sections, choices }) };
  }
  const recordedChoice = (view: ReviewView) => (view.adoption as { state?: string } | null | undefined)?.state === 'recorded';
  const adopted = (view: ReviewView) => {
    const prior = view.adoption as { versionId?: string | null; adopted?: string[]; kept?: string[] };
    return { state: 'recorded' as const, versionId: prior.versionId ?? null, adopted: prior.adopted ?? [], kept: prior.kept ?? [] };
  };
  /** The same request and choices always propose the same R14 revision (R14 is idempotent by request). */
  async function proposeMerged(view: ReviewView, requestId: string, merged: { body: string; fields: StepValues }) {
    if (!deps.propose) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    return deps.propose({ draftId: view.draftId, requestId: derivedUuid(`${view.reviewId}:adopt:${requestId}:propose`),
      sourceVersionId: view.sourceVersionId, body: merged.body, fields: merged.fields });
  }
  const done = (call: ReviewView['calls'][number]) => call.verdict !== null;
  /** Saved bodies of judged calls with their save time (the owner's own review only: reads go through the actor). */
  async function savedOutputs(view: ReviewView) {
    const outputs = new Map<string, { body: string; savedAt: string }>();
    for (const call of view.calls.filter(c => c.verdict !== null)) {
      const result = await admin.rpc('fusion_call_output_read', { p_actor_id: actorId, p_call_id: call.callId });
      if (result.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
      const saved = result.data as { body: string; savedAt: string } | null;
      if (saved?.body) outputs.set(call.callId, { body: saved.body, savedAt: saved.savedAt });
    }
    return outputs;
  }

  return {
    /** The review an earlier start with this request created (lost response), without any live-call precondition. */
    replayStart: (input: { requestId: string; draftId: string; sourceVersionId: string }) => record.replay(input),
    /** Freezes settings, Skill revision and estimate; refuses a review that cannot fit or exceeds the budget. */
    async start(input: { requestId: string; draftId: string; sourceVersionId: string }) {
      // A retried start (lost response) gets its review back before any check that may have changed since (#962 review).
      const existing = await record.replay(input);
      if (existing) return existing;
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
      const view = await record.start({ requestId: input.requestId, draftId: input.draftId, sourceVersionId: input.sourceVersionId,
        config: { estimateUsd, maxRounds: rounds, reviewers: settings.review.reviewerModelIds, summary: settings.review.summaryModelId,
          opinionTokens: settings.review.opinionOutputTokens, summaryTokens: settings.review.summaryOutputTokens, skill } });
      // Before anything is claimed: round 1 and the most trimmed summary, measured exactly as they will be sent, must fit
      // the per-call byte cap; otherwise the review ends here with nothing charged (#962 review).
      if (view.state === 'running' && !view.steps.length && !fitsWhenSent(view, await readSource(view.reviewId), text)) {
        return finish(view, 'incomplete', { kind: 'input_too_large', phase: 'review' });
      }
      return view;
    },
    /** Idempotent: re-judges saved bodies, claims the current step once, or decides the next step / end state. */
    async continue(reviewId: string): Promise<{ review: ReviewView; calls: ReviewView['calls']; waiting?: 'credits' | 'calls' }> {
      let view = await record.read(reviewId);
      if (!view) throw new Error('FUSION_REVIEW_DENIED');
      if (ENDED_STATES.has(view.state)) return { review: view, calls: [] };
      const src = await readSource(reviewId);
      // The start preflight again before the first claim: a start that crashed after creating the record, and was
      // replayed, never ran it (#962 review). Nothing is claimed yet, so ending here charges nothing.
      if (!view.steps.length && view.state === 'running') {
        const skillText = await readReviewSkill(admin, config.parse(view.config).skill as ReviewSkill);
        if (!fitsWhenSent(view, src, skillText)) {
          return { review: await finish(view, 'incomplete', { kind: 'input_too_large', phase: 'review' }), calls: [] };
        }
      }
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
          let claimed;
          try { claimed = await claimStep(view, src, at, pending.length ? pending : models); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'FUSION_INPUT_TOO_LARGE') throw error;
            // A step that cannot fit the byte cap is never claimed: the debate round is skipped; round 1 (nothing charged
            // yet) or the summary ends the review instead of failing on every continue.
            if (at.phase === 'review' && at.round > 1) {
              view = await record.advance(reviewId, at, { state: 'running', round: at.round, phase: 'summary', attempt: 1 });
            } else view = await finish(view, 'incomplete', { kind: 'input_too_large', phase: at.phase });
            continue;
          }
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
        if (at.phase === 'review' && at.round === 1) {
          const opinions = [...(await opinionsOf(view, src, 1)).values()];
          if (!opinions.length) {
            view = await finish(view, 'incomplete', { kind: 'no_opinions' });
          } else if (opinions.length === cfg.reviewers.length
            && opinions.every(opinion => !opinion.issues.length && opinion.decisions.every(d => d.verdict === 'keep'))) {
            // Only the whole panel finding nothing ends here; a partial panel goes on to the summary (#962 review).
            view = await finish(view, 'completed', { kind: 'no_change' });
          } else if (cfg.maxRounds >= 2 && opinions.length >= 2 && hasDisagreement(opinions)) {
            // Round 2 only on a real split over a key decision (Owner 2026-10-14): each reviewer answers the others.
            view = await record.advance(reviewId, at, { state: 'running', round: 2, phase: 'review', attempt: 1 });
          } else {
            view = await record.advance(reviewId, at, { state: 'running', round: 1, phase: 'summary', attempt: 1 });
          }
          continue;
        }
        if (at.phase === 'review') {
          view = await record.advance(reviewId, at, { state: 'running', round: at.round, phase: 'summary', attempt: 1 });
          continue;
        }
        const passed = await passedRevision(view, src);
        // The revision is never re-reviewed by the panel (§8.1, Owner 2026-10-13 选 A): the user now chooses section by
        // section (Owner 2026-10-14); nothing reaches R14 until then.
        view = passed
          ? await finish(view, 'completed', { kind: 'revised', debated: at.round > 1, reviewedByPanel: false, awaitingChoice: true })
          : await finish(view, 'revision_failed', { kind: 'revision_failed' });
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
      const rules = await opinionRules(view, src, step.round, call.modelId ?? null);
      const judge = (text: string): FusionBodyVerdict => run.phase === 'fusion_review'
        ? (parseOpinion(text, rules) ? 'usable' : 'format_invalid')
        : (checkRevision(text, revisionInput(view, src)).ok ? 'usable' : 'revision_invalid');
      if (!deps.executor) throw new Error('FUSION_REVIEW_UNAVAILABLE');
      return deps.executor.run(run, { runId: call.runId, id: callId, state: call.state, fresh: false }, judge, onChunk);
    },
    stop: (reviewId: string) => record.close(reviewId, 'stopped'),
    end: (reviewId: string) => record.close(reviewId, 'interrupted'),
    /** Per-section adoption, step 1: validates the choices and, when any section is adopted, proposes the merged text
     * to R14 and returns its diff (field changes and the cascade of dependent steps) for the user to see. Nothing is
     * applied here. Choosing to keep every section records the choice at once (nothing to confirm). */
    async adopt(input: { reviewId: string; requestId: string; choices: AdoptionChoice[] }) {
      const { view, merged } = await adoptionInput(input);
      if (recordedChoice(view)) return adopted(view);
      if (!merged.adopted.length) {
        await record.recordAdoption(view.reviewId, { state: 'recorded', requestId: input.requestId, choices: input.choices, decision: 'kept',
          adopted: [], kept: merged.kept, revisionId: null, versionId: null });
        return { state: 'recorded' as const, versionId: null, adopted: [], kept: merged.kept };
      }
      const proposal = await proposeMerged(view, input.requestId, merged);
      return { state: 'proposed' as const, revisionId: proposal.revisionId, diff: proposal.diff, diffHash: proposal.diffHash,
        adopted: merged.adopted, kept: merged.kept };
    },
    /** Step 2: the user, having seen the diff, applies it (a new formal version) or declines it (nothing changes).
     * The same choices re-propose idempotently; the diff must be the one the user saw. Recorded once. */
    async confirmAdoption(input: { reviewId: string; requestId: string; choices: AdoptionChoice[]; expectedDiffHash: string;
      decision: 'apply' | 'decline' }) {
      const { view, merged } = await adoptionInput(input);
      if (recordedChoice(view)) return adopted(view);
      if (!merged.adopted.length || !deps.apply || !deps.decline) throw new Error('FUSION_ADOPTION_INVALID');
      // A reservation binds its decision: a retry of the same request cannot switch apply to decline or back (#962 review).
      // The choices too, exactly as reserved (the database completes only an identical reservation), compared before
      // any R14 call so a retry can never apply and then fail to record (#962 review).
      const reserved = view.adoption as { decision?: string; choices?: unknown } | null | undefined;
      if (reserved && (reserved.decision !== input.decision || canonical(reserved.choices) !== canonical(adoptionChoices.parse(input.choices)))) {
        throw new Error('FUSION_REVIEW_ADOPTED');
      }
      const proposal = await proposeMerged(view, input.requestId, merged);
      if (proposal.diffHash !== input.expectedDiffHash) throw new Error('FUSION_ADOPTION_STALE');
      // Reserve the choice under the review lock before R14 decides anything: a concurrent request is refused from
      // here on, so the formal version and the recorded choice can never disagree (#962 review).
      const won = await record.recordAdoption(view.reviewId, { state: 'reserved', requestId: input.requestId, choices: input.choices,
        decision: input.decision });
      // A concurrent confirmation of the same request may have reserved first with other choices or another decision:
      // only the request whose exact reservation is stored may make the external decision (#962 review).
      const stored = won.adoption as { state?: string; decision?: string; choices?: unknown } | null | undefined;
      if (stored?.state !== 'reserved' || stored.decision !== input.decision
        || canonical(stored.choices) !== canonical(adoptionChoices.parse(input.choices))) throw new Error('FUSION_REVIEW_ADOPTED');
      const decisionId = derivedUuid(`${view.reviewId}:adopt:${input.requestId}:${input.decision}`);
      let versionId: string | null = null;
      try {
        if (input.decision === 'apply') {
          ({ versionId } = await deps.apply({ draftId: view.draftId, revisionId: proposal.revisionId, expectedDiffHash: proposal.diffHash,
            requestId: decisionId }));
        } else await deps.decline({ draftId: view.draftId, revisionId: proposal.revisionId, requestId: decisionId });
      } catch (error) {
        // R14 refuses for good (a newer formal version, erased content...): finish the reservation as refused, with
        // nothing adopted, so the review does not wait for a choice forever (#962 review). Transient errors retry.
        const code = error instanceof Error ? error.message : '';
        if (!PERMANENT_REFUSALS.has(code)) throw error;
        await record.recordAdoption(view.reviewId, { state: 'recorded', requestId: input.requestId, choices: input.choices,
          decision: 'refused', refusal: code, adopted: [], kept: [...merged.adopted, ...merged.kept], revisionId: proposal.revisionId,
          versionId: null });
        throw error;
      }
      const applied = input.decision === 'apply';
      await record.recordAdoption(view.reviewId, { state: 'recorded', requestId: input.requestId, choices: input.choices, decision: input.decision,
        adopted: applied ? merged.adopted : [], kept: applied ? merged.kept : [...merged.adopted, ...merged.kept],
        revisionId: proposal.revisionId, versionId });
      return { state: 'recorded' as const, versionId, adopted: applied ? merged.adopted : [],
        kept: applied ? merged.kept : [...merged.adopted, ...merged.kept] };
    },
    /** Full record for the owner (no 120-character summaries): each seat's reasoning and the rulings by section. */
    async detail(reviewId: string) {
      const view = await record.read(reviewId);
      if (!view) throw new Error('FUSION_REVIEW_DENIED');
      const src = await readSource(reviewId);
      return reviewDetail({ view, reviewers: config.parse(view.config).reviewers, sections: src.sections,
        outputs: await savedOutputs(view), revision: revisionInput(view, src), adoption: (await adoptionPlan(view, src))?.sections ?? null });
    },
    /** Progress events for the animation (§2.2a), derived from the record and judged outputs only. */
    async events(reviewId: string) {
      const view = await record.read(reviewId);
      if (!view) throw new Error('FUSION_REVIEW_DENIED');
      const src = await readSource(reviewId);
      const outputs = await savedOutputs(view);
      return reviewEvents({ view, reviewers: config.parse(view.config).reviewers, sections: src.sections, outputs,
        revision: revisionInput(view, src) });
    },
    rejudge: async (reviewId: string) => {
      const view = await record.read(reviewId);
      if (view) await rejudge(view, await readSource(reviewId));
    },
  };
}
