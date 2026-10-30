/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { logSwallowed } from '../../lib/swallow';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkRevision, parseOpinion } from '../fusion/hostChecks';
import { fusionRequestBody } from '../fusion/request';
import { config, reviewCore, type Source } from '../fusion/reviewCore';
import { estimateReview } from '../fusion/reviewEstimate';
import { readReviewSkill, resolveReviewSkill, reviewLanguageRule } from '../fusion/reviewPrompts';
import { ENDED_STATES, reviewRecord, type ReviewPosition, type ReviewView } from '../fusion/reviewRecord';
import { claimOutcome } from '../fusion/reviewLimits';
import { readFusionSettings } from '../fusion/settings';
import { assertFusionEntitlement, readMembershipEntitlements } from '../membershipEntitlements';
import { readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { readAdmissionConfiguration, type ConfigurationRows } from '../runtime/admissionConfiguration';
import { rowFor } from '../runtime/settingsRows';
import type { PricingDeps } from '../runtime/pricingAdmission';
import type { RuntimeCallGate } from '../runtime/newWorkGate';
import { readReplyLocale } from '../runtime/replyLanguage';
import { TurnStop } from './call';
import { CORE_PATH_SETTING } from './chat';
import { TurnDatabaseError, type TurnClients } from './db';
import { breakerTripped, fusionAdmission, fusionCoreSetting, fusionDatabase, fusionPolicy, runGroup, type GroupMember,
  type Judged } from './fusionCalls';
import { fusionCall, fusionQuote, type FusionQuote } from './fusionQuote';
import type { CounterStore } from './limiter';
import { callCredits } from './policy';
import { QuoteError } from './quote';

/*
 * CORE-PATH-V2 kind=jury (2.7, FUSION-REVIEW): one turn per review. The user pays the fixed price (Owner 10-17, default 1500);
 * the freeze is that price plus the largest group's temporary bound (10-13), and the seats' costs are receipts for the platform,
 * never charged per seat. A review advances one group per invocation (the relay of FUSION-BACKGROUND): the group's calls run in
 * parallel; between groups the turn waits (paused, awaiting_user) and the next group's first begin resumes it; 24 hours
 * without one, recovery ends it (turn_fusion_recovery). The review's decisions are the BILL2 review's own (reviewCore): the
 * same requests, host checks and next position. Delivery (turn_user_charge): a summary that passes the host check and changes a
 * section pays the price whatever happens next; no change, a failed revision or an incomplete review refunds everything; an
 * interruption or the 24-hour end pays the known usage, at most the price.
 */
export type JuryDeps = { admin: SupabaseClient; clients: TurnClients; slots: CounterStore; transport?: typeof fetch;
  pricing?: PricingDeps; sleep?: (ms: number) => Promise<void>;
  /** The one-switch pause and the account's call limits before every seat call (runtime/newWorkGate.ts). */
  calls: RuntimeCallGate };
export type JuryAdvance = { next: boolean; reason: string; dispatched?: number };
const GATED = new Set(['TURN_NEW_CALLS_PAUSED', 'TURN_RATE_LIMITED', 'TURN_LIMIT_UNAVAILABLE', 'TURN_USAGE_CONFIGURATION_REQUIRED']);
const TRANSIENT = new Set(['TURN_DATABASE_UNAVAILABLE', 'TURN_PROVIDER_KEY_UNAVAILABLE', 'TURN_PRICE_UNAVAILABLE',
  'TURN_BILLING_UNIT_UNAVAILABLE']);
const ATTEMPTS = 3, NIL = '00000000-0000-0000-0000-000000000000';
const stepKey = (at: ReviewPosition) => `review:${at.round}:${at.phase}:${at.attempt}`;
const codeOf = (error: unknown) => error instanceof QuoteError || error instanceof TurnStop || error instanceof TurnDatabaseError
  ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'TURN_FAILED';

async function coreSettings(configuration: ConfigurationRows) {
  const core = rowFor(configuration, CORE_PATH_SETTING);
  const parsed = fusionCoreSetting.safeParse(core.error ? null : core.data?.value);
  if (!parsed.success || !parsed.data.enabled) throw new Error('TURN_CORE_DISABLED');
  return parsed.data;
}

/** Each panel model's quote for its phase, the turn's way (fusionQuote): reviewers and the summary. */
async function panelQuotes(deps: JuryDeps, cfg: { reviewers: string[]; summary: string; opinionTokens: number; summaryTokens: number }, key: string) {
  // The settings come with the admission configuration (one cached query for every setting), never a query of their own.
  const configuration = await readAdmissionConfiguration(deps.admin);
  const reviewers = await Promise.all(cfg.reviewers.map(modelId => fusionQuote(deps.admin, { configuration, modelId, phase: 'fusion_review',
    outputTokens: cfg.opinionTokens, key, deps: deps.pricing })));
  const summary = await fusionQuote(deps.admin, { configuration, modelId: cfg.summary, phase: 'fusion_summary', outputTokens: cfg.summaryTokens, key,
    deps: deps.pricing });
  return { reviewers, summary, of: (modelId: string, phase: 'fusion_review' | 'fusion_summary') =>
    phase === 'fusion_summary' ? summary : reviewers.find(q => q.modelId === modelId)! };
}

/** The quotes estimateReview reads, one per model (it matches by model id): a model that is both a reviewer and the summary
 * keeps the larger of its two output limits, since each phase's bound takes the smaller of that limit and its own tokens. */
export function estimateQuotes(quotes: readonly FusionQuote[]) {
  const byModel = new Map<string, { modelId: string; providerLimits: FusionQuote['policy']['providerLimits']; outputLimit: number;
    multiplier: string }>();
  for (const quote of quotes) {
    const known = byModel.get(quote.modelId);
    if (!known || quote.outputLimit > known.outputLimit) byModel.set(quote.modelId, { modelId: quote.modelId,
      providerLimits: quote.policy.providerLimits, outputLimit: quote.outputLimit, multiplier: quote.multiplier });
  }
  return [...byModel.values()];
}

export function juryTurn(deps: JuryDeps, actorId: string) {
  const { admin } = deps;
  const record = reviewRecord(admin, actorId), core = reviewCore(admin, actorId), db = fusionDatabase(deps.clients, actorId);

  /** The plan of a start, the BILL2 planReview's on the turn path's quotes: settings, Skill, sizes, worst-case bounds per call. */
  async function plan(input: { draftId: string; sourceVersionId: string }) {
    const settings = (await readFusionSettings(admin)).review;
    if (!settings.enabled) throw new Error('FUSION_REVIEW_DISABLED');
    if (!settings.skillId || !settings.summaryModelId || !settings.maxBudgetUsd) throw new Error('FUSION_REVIEW_INCOMPLETE');
    const skill = await resolveReviewSkill(admin, settings.skillId);
    const text = await readReviewSkill(admin, skill);
    const replyLocale = await readReplyLocale(admin, actorId);
    const sizes = await admin.rpc('fusion_review_preview', { p_actor_id: actorId, p_draft_id: input.draftId,
      p_source_version_id: input.sourceVersionId });
    if (sizes.error) throw new Error('FUSION_REVIEW_STALE');
    const preview = z.object({ reportSentBytes: z.number(), materialsSentBytes: z.number(), fieldCount: z.number() }).passthrough().parse(sizes.data);
    const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
    if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
    const quotes = await panelQuotes(deps, { reviewers: settings.reviewerModelIds, summary: settings.summaryModelId,
      opinionTokens: settings.opinionOutputTokens, summaryTokens: settings.summaryOutputTokens }, key);
    const all = [...quotes.reviewers, quotes.summary];
    const q = all[0]!.q;
    const sent = (value: string) => Buffer.byteLength(JSON.stringify(value)) + 4096;
    const estimate = estimateReview({ quotes: estimateQuotes(all) as never, creditsPerUsd: q,
      reviewers: settings.reviewerModelIds, summary: settings.summaryModelId, maxRounds: settings.maxRounds,
      maxBudgetUsd: settings.maxBudgetUsd, opinionTokens: settings.opinionOutputTokens, summaryTokens: settings.summaryOutputTokens,
      fieldCount: preview.fieldCount, snapshotBytes: preview.reportSentBytes + preview.materialsSentBytes,
      instructionBytes: { reviewer: sent(`${text.reviewer}\n\n${text.rubric}${reviewLanguageRule(replyLocale, 'reviewer')}`),
        summary: sent(`${text.summary}\n\n${text.rubric}${reviewLanguageRule(replyLocale, 'summary')}`) } });
    const sum = (caps: Record<string, { credits: number }>) => Object.values(caps).reduce((total, cap) => total + cap.credits, 0);
    const holdCredits = Math.max(sum(estimate.callCaps.review), sum(estimate.callCaps.debate), sum(estimate.callCaps.summary));
    return { settings, skill, estimate, q, holdCredits, priceCredits: settings.fixedPriceCredits, replyLocale, quotes: all };
  }

  /** Ends the review and its turn in one statement (turn_fusion_close). */
  /** The review record's claim of a step or move to the next position (fusion_review_turn_step, compare-and-set). */
  const step = async (reviewId: string, from: ReviewPosition, to: Record<string, unknown>) => {
    const result = await admin.rpc('fusion_review_turn_step', { p_actor_id: actorId, p_review_id: reviewId, p_from: from, p_to: to });
    if (result.error) throw new Error(/FUSION_REVIEW_[A-Z_]+/.exec(result.error.message ?? '')?.[0] ?? 'FUSION_REVIEW_UNAVAILABLE');
  };
  const end = (view: ReviewView, state: 'completed' | 'incomplete' | 'revision_failed' | 'interrupted', outcome: Record<string, unknown>,
    deliverable = false) => db.close({ turnId: view.turnId!, kind: state === 'completed' ? 'completed' : state === 'interrupted' ? 'interrupted' : 'failed',
    delivered: deliverable, refundAll: state === 'incomplete' || state === 'revision_failed',
    failureCode: state === 'completed' ? null : `review_${String(outcome.kind ?? state)}`.slice(0, 120), product: { state, outcome } });

  /** Ended by another path (an archived business ends the review on read): its turn closes by that end now, so an incomplete
   * review refunds at once instead of waiting for the 24-hour end (turn_fusion_ended_review; idempotent). */
  const endedElsewhere = async (view: ReviewView): Promise<JuryAdvance> => {
    if (view.fee?.state === 'held') {
      const closed = await admin.rpc('turn_fusion_ended_review', { p_actor_id: actorId, p_turn_id: view.turnId, p_state: view.state,
        p_outcome: view.outcome ?? {} });
      if (closed.error) throw new TurnDatabaseError('TURN_DATABASE_UNAVAILABLE');
    }
    return { next: false, reason: 'ended' };
  };

  return {
    /** What a start freezes, without creating anything ("最多消耗 X 积分" shows the price; the balance must cover price + hold). */
    async estimate(input: { draftId: string; sourceVersionId: string }) {
      const { priceCredits, holdCredits, estimate, settings } = await plan(input);
      return { estimateCredits: priceCredits, holdCredits, requiredCredits: priceCredits + holdCredits, maxRounds: estimate.rounds,
        reviewers: settings.reviewerModelIds.length };
    },
    /** Starts the review and opens its turn in one transaction; a repeat of the request returns the same review and turn. */
    async start(input: { requestId: string; draftId: string; sourceVersionId: string; acceptedCredits?: number }): Promise<ReviewView> {
      const replayed = await record.replay(input);
      if (replayed?.turnId) return replayed;
      const coreSetting = await coreSettings(await readAdmissionConfiguration(admin));
      const { settings, skill, estimate, q, holdCredits, priceCredits, replyLocale, quotes } = await plan(input);
      if (input.acceptedCredits !== undefined && priceCredits !== input.acceptedCredits) throw new Error('FUSION_REVIEW_ESTIMATE_CHANGED');
      const planned = [...Object.values(estimate.callCaps.review), ...Object.values(estimate.callCaps.debate),
        ...Object.values(estimate.callCaps.summary)].map(cap => ({ upperUsd: cap.usd, multiplier: '1' }));
      const policy = fusionPolicy({ q, calls: planned, gCredits: priceCredits + holdCredits, minCredits: priceCredits + holdCredits,
        fixedCredits: priceCredits, stopLoss: coreSetting.stopLoss, quotes });
      const reviewConfig = { path: 'turn', estimateUsd: estimate.estimateUsd, estimateCredits: priceCredits,
        fixedPrice: { credits: priceCredits, holdCredits }, callCaps: estimate.callCaps, maxRounds: estimate.rounds,
        reviewers: settings.reviewerModelIds, evidence: true,
        roles: settings.reviewerModelIds.map(id => settings.reviewerRoles[id] ?? null), summary: settings.summaryModelId,
        opinionTokens: settings.opinionOutputTokens, summaryTokens: settings.summaryOutputTokens, skill,
        requestBytes: estimate.requestBytes, replyLocale };
      // Read before the open (fusion_review_turn_source): the old start's permission checks and the review record's fields;
      // turn_fusion_open writes them with the checks that must be atomic. A repeat of this request is not refused as active.
      const source = await fusionAdmission(deps.clients, actorId).reviewSource(input)
        .catch(error => { throw new Error(error instanceof TurnDatabaseError ? error.code : 'FUSION_REVIEW_UNAVAILABLE'); });
      if (breakerTripped(source.breaker, settings.breaker)) throw new Error('FUSION_REVIEW_BREAKER');
      // The conversation is the review's draft conversation, set by the database (NIL here).
      const opened = await db.open({ sessionId: NIL, requestId: input.requestId, kind: 'jury', policy,
        product: { start: { draftId: source.draftId, projectId: source.projectId, sessionId: source.sessionId,
          sourceVersionId: source.sourceVersionId, versionHash: source.versionHash, materials: source.materials, config: reviewConfig } } });
      const view = (await record.read(opened.reviewId!))!;
      // Round 1 and the most trimmed summary must fit the per-call byte cap before anything is sent (#962 review).
      if (!opened.replay && !core.fitsWhenSent(view, await core.readSource(view.reviewId), await readReviewSkill(admin, skill))) {
        await end(view, 'incomplete', { kind: 'input_too_large', phase: 'review' });
        return (await record.read(view.reviewId))!;
      }
      return view;
    },
    /** One group of the review: claim the current step, run its calls in parallel, decide the next position or end. */
    async advance(reviewId: string): Promise<JuryAdvance> {
      let view = await record.read(reviewId);
      if (!view?.turnId) return { next: false, reason: 'not_turn_path' };
      if (ENDED_STATES.has(view.state)) return endedElsewhere(view);
      const src = await core.readSource(reviewId);
      const cfg = config.parse(view.config);
      const at: ReviewPosition = { round: view.round, phase: view.phase, attempt: view.attempt };
      const claimed = view.steps.find(s => s.stepKey === stepKey(at));
      const sent = claimed ? view.calls.filter(c => c.groupId === claimed.groupId) : [];
      let dispatched = 0;
      // A step claimed but none of whose calls was begun (gated, or cut off right after the claim) is sent now, not decided.
      if (!claimed || !sent.length) {
        const here = core.callsAt(view, at.round, at.phase === 'review' ? 'review' : 'summary');
        const models = (at.phase === 'review' ? cfg.reviewers : [cfg.summary])
          .filter(id => !here.some(call => call.modelId === id && call.verdict !== null && call.verdict !== 'no_delivery'));
        let members: GroupMember[];
        try { members = await groupMembers(view, src, at, models); }
        catch (error) {
          // A step refused for good (the BILL2 review's claimOutcome: switch off, membership, allowlist, size, price) ends or
          // skips as there; what may clear by retrying (database, key, price snapshot) is thrown and retried by the relay.
          const code = codeOf(error);
          const outcome = TRANSIENT.has(code) ? null : claimOutcome(new Error(code));
          if (!outcome) throw error;
          // A step refused for good: a debate round is skipped; round 1 or the summary ends the review (earlier receipts stay).
          if (at.phase === 'review' && at.round > 1) {
            await step(reviewId, at, { state: 'running', round: at.round, phase: 'summary', attempt: 1 });
            return { next: true, reason: 'advanced' };
          }
          await end(view, 'incomplete', { ...outcome, phase: at.phase });
          return { next: false, reason: 'ended' };
        }
        // The pause and the call limits for the whole group before it is claimed (the old path's call gate): a refusal claims,
        // writes and sends nothing, and a later relay or the daily backstop tries the same step again.
        const gate = await deps.calls(actorId, members.length, 'bill2.v2');
        if (!gate.ok) return { next: false, reason: 'gated' };
        const fromSeq = Math.max(0, ...view.calls.map(c => c.seq ?? 0)) + 1;
        if (!claimed) await step(reviewId, at, { state: 'claim', fromSeq });
        let seq = fromSeq - 1;
        const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
        if (!key) return { next: false, reason: 'failed' };
        const outcomes = await runGroup({ db, slots: deps.slots, actorId, turnId: view.turnId, nextSeq: () => ++seq,
          credential: async () => key, transport: deps.transport, sleep: deps.sleep, calls: async () => ({ ok: true }) }, members);
        dispatched = outcomes.length;
        const stops = outcomes.flatMap(o => o.ok ? [] : [o.code]);
        if (stops.includes('TURN_TOMBSTONED')) {
          await db.close({ turnId: view.turnId, kind: 'erased', delivered: false, failureCode: 'turn_tombstoned',
            product: { state: 'interrupted', outcome: { kind: 'erased' } } }).catch(error => logSwallowed('jury_erased_close_failed', error,
            { category: 'billing', reviewId }));
          return { next: false, reason: 'ended' };
        }
        if (stops.includes('TURN_PAUSED_FOR_CREDITS')) return { next: false, reason: 'waiting_credits' };
        // Paused by the administrator or over the call limits: nothing was sent; the relay stops and the daily backstop (or the
        // 24-hour end) picks the review up, as a refused BILL2 call gate did.
        if (stops.some(code => GATED.has(code))) return { next: false, reason: 'gated' };
        // A call sent whose outcome is unknown: never sent again; the crash sweep and recovery settle it and end the review.
        if (stops.includes('TURN_CALL_UNKNOWN')) return { next: false, reason: 'in_flight' };
        view = (await record.read(reviewId))!;
        // Ended meanwhile (the business archived while the group ran): that end settles it, not the answers just saved.
        if (ENDED_STATES.has(view.state)) return endedElsewhere(view);
        // A call of this step sent but without a judged answer (its receipt failed to save, its outcome unknown) is settled by
        // recovery, never sent again; the step waits instead of retrying. An answer already saved and judged, whose cost alone
        // is pending, does not hold the step: the review goes on with it and recovery settles the cost.
        const current = view.steps.find(s => s.stepKey === stepKey(at));
        if (view.calls.some(c => c.groupId === current?.groupId && !c.verdict
          && ['dispatched', 'identified', 'unknown'].includes(c.state))) {
          return { next: false, reason: 'in_flight' };
        }
        // Nothing was sent at all (refused locally, provider busy: every attempt certainly unsent or free), the step is tried
        // again in a new attempt, bounded.
        if (stops.length === outcomes.length && at.attempt < ATTEMPTS) {
          await step(reviewId, at, { state: 'running', round: at.round, phase: at.phase, attempt: at.attempt + 1 });
          return { next: true, reason: 'retry', dispatched };
        }
      } else if (sent.some(c => !c.verdict && (c.state === 'dispatched' || c.state === 'identified'))) {
        return { next: false, reason: 'in_flight' };
      }
      // Every call of the step has its receipt: the same decision as the BILL2 review (reviewCore.decide).
      const next = await core.decide(view, src, at);
      if (next.state === 'running') {
        await step(reviewId, at, next);
        return { next: true, reason: 'advanced', dispatched };
      }
      const deliverable = next.state === 'completed' && (next.outcome as { kind?: string }).kind === 'revised';
      await end(view, next.state, next.outcome, deliverable);
      return { next: false, reason: 'ended', dispatched };
    },
  };

  /** The step's calls: the review's own requests (reviewCore), each bounded on its exact body within its frozen cap. */
  async function groupMembers(view: ReviewView, src: Source, at: ReviewPosition, models: string[]): Promise<GroupMember[]> {
    const cfg = config.parse(view.config);
    // The live permissions before every group, as the BILL2 group admission (admission.ts): the switch, the membership and the
    // allowlist may have changed since the review started; a revoked one never sends another paid call.
    const settings = (await readFusionSettings(admin)).review;
    if (!settings.enabled) throw new Error('FUSION_REVIEW_DISABLED');
    assertFusionEntitlement(await readMembershipEntitlements(admin, actorId), 'review', models.length);
    if (models.some(id => at.phase === 'summary' ? settings.summaryModelId !== id : !settings.reviewerModelIds.includes(id)))
      throw new Error('FUSION_MODEL_DENIED');
    const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
    if (!key) throw new QuoteError('TURN_PROVIDER_KEY_UNAVAILABLE');
    const quotes = await panelQuotes(deps, cfg, key);
    const caps = cfg.callCaps?.[core.phaseOf(at)] ?? {};
    const requests = await core.buildMembers(view, src, at, models);
    return Promise.all(requests.map(async member => {
      const quote: FusionQuote = quotes.of(member.modelId, member.phase);
      const body = fusionRequestBody(quote.policy as never, member.request, quote.outputLimit, quote.reasoning);
      const call = fusionCall(quote, body);
      const cap = caps[member.modelId];
      if (!cap || callCredits(quote.q, call.upperUsd, call.multiplier) > cap.credits || Number(call.upperUsd) > Number(cap.usd))
        throw new Error('FUSION_ESTIMATE_EXCEEDED');
      const rules = await core.opinionRules(view, src, at.round, member.modelId);
      const judge = (text: string): Judged => {
        if (member.phase === 'fusion_review') return { verdict: parseOpinion(text, rules) ? 'usable' : 'format_invalid' };
        const checked = checkRevision(text, core.revisionInput(view, src));
        return checked.ok ? { verdict: 'usable', deliverable: checked.changedSections.length > 0 } : { verdict: 'revision_invalid' };
      };
      return { call, body, phase: member.phase, judge };
    }));
  }
}
