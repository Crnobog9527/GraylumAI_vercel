/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitFusionGroup, derivedUuid, replayFusionGroup } from './admission';
import { fusionExecutor, type FusionBodyVerdict } from './executor';
import { checkRevision, parseOpinion, type StepValues } from './hostChecks';
import { readReviewSkill, type ReviewSkill } from './reviewPrompts';
import { config, type Source } from './reviewCore';
import { reviewDetail, reviewEvents } from './reviewEvents';
import { adoptionChoices, adoptionSections, applyChoices, sectionTexts, type AdoptionChoice } from './reviewAdoption';
import { ENDED_STATES, reviewRecord, type ReviewPosition, type ReviewView } from './reviewRecord';
import { claimOutcome, memberCaps, PERMANENT_REFUSALS } from './reviewLimits';
import { planReview } from './reviewPlan';
import { evidenceDetail } from './reviewEvidenceFlow';
import { reviewCore } from './reviewCore';

type Executor = ReturnType<typeof fusionExecutor>;
const ATTEMPTS = 3;
/** JSON with sorted keys: the database stores choices as jsonb, which does not keep key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);
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
  const core = reviewCore(admin, actorId);
  const { readSource, frozenValues, callsAt, passedRevision, revisionInput, opinionRules, rejudge,
    fitsWhenSent, phaseOf } = core;
  /** Admits and claims the models of the current position that have no finished call yet. */
  async function claimStep(view: ReviewView, src: Source, at: ReviewPosition, models: string[]) {
    const cfg = config.parse(view.config);
    const members = await core.buildMembers(view, src, at, models);
    const requestId = derivedUuid(`${view.reviewId}:${stepKey(at)}`);
    const group = await admitFusionGroup({ admin, actorId, requestId, sourceSessionId: view.sourceSessionId, members, env,
      outputTokens: { opinion: cfg.opinionTokens, summary: cfg.summaryTokens },
      ...memberCaps(cfg.callCaps?.[phaseOf(at)], members) });
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
    return { view, merged: applyChoices({ originalBody: src.body, revisedBody: plan.passed.body, plan: plan.sections, choices,
      maxCharacters: src.maxCharacters }) };
  }
  const recordedChoice = (view: ReviewView) => (view.adoption as { state?: string } | null | undefined)?.state === 'recorded';
  const adopted = (view: ReviewView) => {
    const prior = view.adoption as { versionId?: string | null; adopted?: string[]; kept?: string[]; decision?: string; refusal?: string };
    // A permanent R14 refusal stays a refusal on every retry: a lost error response must not read as a completed
    // adoption with everything kept (#962 review).
    if (prior.decision === 'refused') throw new Error(prior.refusal || 'FUSION_REVIEW_ADOPTED');
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

  const plan = (input: { draftId: string; sourceVersionId: string }) => planReview({ admin, actorId, env, ...input });
  /** An ended review whose fee is still held (a stop waiting for in-flight calls) gets another settlement try. */
  async function settled(view: ReviewView | null): Promise<ReviewView> {
    if (!view) throw new Error('FUSION_REVIEW_DENIED');
    if (!ENDED_STATES.has(view.state) || view.fee?.state !== 'held') return view;
    return { ...view, fee: await record.settleFee(view.reviewId) ?? view.fee };
  }

  return {
    /** The review an earlier start with this request created (lost response), without any live-call precondition. */
    replayStart: (input: { requestId: string; draftId: string; sourceVersionId: string }) => record.replay(input),
    /** What a start would freeze and hold at most, computed exactly as start does, without creating anything: the page
     * shows "最多消耗 X 积分" from it before the user agrees (FUSION-REVIEW §3.2, Master Plan §4.1). */
    async estimate(input: { draftId: string; sourceVersionId: string }) {
      const { settings, rounds, priceCredits, holdCredits } = await plan(input);
      // estimateCredits is now the fixed price (0294); requiredCredits is what the balance must cover to start.
      return { estimateCredits: priceCredits, holdCredits, requiredCredits: priceCredits + holdCredits, maxRounds: rounds,
        reviewers: settings.review.reviewerModelIds.length };
    },
    /** Freezes settings, Skill revision and estimate; refuses a review that cannot fit or exceeds the budget. A start
     * that carries the maximum the user agreed to is refused when the maximum is now higher (prices changed meanwhile). */
    async start(input: { requestId: string; draftId: string; sourceVersionId: string; acceptedCredits?: number }) {
      // A retried start (lost response) gets its review back before any check that may have changed since (#962 review).
      const existing = await record.replay(input);
      if (existing) return existing;
      const { settings, skill, text, rounds, estimateUsd, callCaps, requestBytes, priceCredits, holdCredits, replyLocale } = await plan(input);
      if (input.acceptedCredits !== undefined && priceCredits !== input.acceptedCredits) throw new Error('FUSION_REVIEW_ESTIMATE_CHANGED');
      const view = await record.start({ requestId: input.requestId, draftId: input.draftId, sourceVersionId: input.sourceVersionId,
        config: { estimateUsd, estimateCredits: priceCredits, fixedPrice: { credits: priceCredits, holdCredits }, callCaps,
          maxRounds: rounds, reviewers: settings.review.reviewerModelIds, evidence: true,
          roles: settings.review.reviewerModelIds.map(id => settings.review.reviewerRoles[id] ?? null), summary: settings.review.summaryModelId,
          opinionTokens: settings.review.opinionOutputTokens, summaryTokens: settings.review.summaryOutputTokens, skill, requestBytes, replyLocale } });
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
      // Paused too: an idle zero-step review is paused by the daily job and resumed by its first claim (#962 review).
      if (!view.steps.length && (view.state === 'running' || view.state === 'paused')) {
        let skillText;
        try { skillText = await readReviewSkill(admin, config.parse(view.config).skill as ReviewSkill); }
        catch (error) {
          // A Skill revoked before the first claim ends the review the same way a refused claim does.
          const outcome = claimOutcome(error);
          if (!outcome) throw error;
          return { review: await finish(view, 'incomplete', { ...outcome, phase: 'review' }), calls: [] };
        }
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
            const outcome = claimOutcome(error);
            if (!outcome) throw error;
            // A step refused for good is never claimed: the debate round is skipped; round 1 (nothing charged yet) or
            // the summary ends the review (earlier calls are already settled) instead of failing on every continue.
            if (at.phase === 'review' && at.round > 1) {
              view = await record.advance(reviewId, at, { state: 'running', round: at.round, phase: 'summary', attempt: 1 });
            } else {
              view = await finish(view, 'incomplete', { ...outcome, phase: at.phase });
            }
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
        const next = await core.decide(view, src, at);
        view = next.state === 'running' ? await record.advance(reviewId, at, next) : await finish(view, next.state, next.outcome);
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
    /** The review as it stands, without advancing it (the page reads while the server advances). */
    read: async (reviewId: string) => settled(await record.read(reviewId)),
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
      const view = await settled(await record.read(reviewId));
      const src = await readSource(reviewId);
      const cfg = config.parse(view.config);
      const outputs = await savedOutputs(view);
      const detail = reviewDetail({ view, reviewers: cfg.reviewers, sections: src.sections, outputs, revision: revisionInput(view, src),
        adoption: (await adoptionPlan(view, src))?.sections ?? null, roles: cfg.roles ?? [], ...evidenceDetail(cfg, view, src, outputs) });
      // The reviewed (frozen) report by chapter: the result page shows the whole report, not only the changed chapters.
      const text = sectionTexts(src.body, src.sections);
      return { ...detail, chapters: text.chapters, preamble: text.preamble, fee: view.fee ?? null };
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
    rejudge: async (reviewId: string): Promise<string[]> => {
      const view = await record.read(reviewId);
      return view ? rejudge(view, await readSource(reviewId)) : [];
    },
  };
}
