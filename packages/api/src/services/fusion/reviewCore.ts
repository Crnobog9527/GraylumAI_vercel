/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FusionMember } from './admission';
import type { FusionBodyVerdict } from './executor';
import { checkRevision, DECISIONS, disputedDecisions, hasDisagreement, parseOpinion, type DeclaredStep, type Opinion, type StepValues } from './hostChecks';
import { assertSnapshotSize, fusionRequestBytes, type FusionRequest } from './request';
import { PAYG_PROFILE_MAX_BYTES } from '../runtime/paygHostPolicy';
import { debateRequest, readReviewSkill, reviewerLabel, reviewLocale, reviewerRequest, summaryRequest, summaryRequestMerged, type ReviewContext,
  type ReviewSkill } from './reviewPrompts';
import type { ReviewPosition, ReviewView } from './reviewRecord';
import { reportBodyText } from '../../shared/reportData';
import { evidenceRules, roleOf } from './reviewEvidenceFlow';
import { mergeOpinions } from './reviewMerge';
import { REVIEWER_ROLES } from './reviewEvidence';

/** What a review decides from its record and saved answers, without billing: the frozen config, the reviewed source, each
 * phase's requests, the host checks and the next position after a finished step. Shared by the BILL2 review flow (review.ts)
 * and the CORE-PATH-V2 jury turn (turn/jury.ts), so both run the same review. */
export const config = z.object({ estimateUsd: z.string(), maxRounds: z.number().int().min(1), reviewers: z.array(z.string().uuid()).min(1),
  evidence: z.boolean().optional(), roles: z.array(z.enum(REVIEWER_ROLES).nullable()).optional(),
  /** The turn path's frozen provider route of each model (absent on BILL2 reviews). */
  models: z.record(z.string(), z.string()).optional(),
  /** "最多消耗 X 积分" (§3.2), shown before the user agrees; absent on reviews started before it was recorded. */
  estimateCredits: z.number().int().positive().optional(),
  /** Each call's credit and dollar bounds by phase and model, frozen with that maximum (absent on older reviews: no cap). */
  callCaps: z.record(z.enum(['review', 'debate', 'summary']),
    z.record(z.string(), z.object({ credits: z.number().int(), usd: z.string() }))).optional(),
  opinionTokens: z.number().int().positive(), summaryTokens: z.number().int().positive(),
  /** Per-phase request size the estimate priced (absent: only the byte cap applies). */
  requestBytes: z.object({ review: z.number(), debate: z.number(), summary: z.number() }).optional(),
  summary: z.string().uuid(), skill: z.object({ skillId: z.string().uuid(), revisionId: z.string().uuid(),
    packageHash: z.string() }) }).passthrough();
export const source = z.object({ body: z.string().min(1), sections: z.array(z.string()).min(1), maxCharacters: z.number().int().positive(),
  declared: z.array(z.object({ stepId: z.string(), fieldIds: z.array(z.string()) })) });
export type Source = z.infer<typeof source>;
/** The summary's revision that passed the host check: what R14 proposes. */
export type Passed = { round: number; body: string; steps: StepValues; changeNotes: unknown; changedSections: string[]; r14Fields: StepValues };
export type ReviewDecision = { state: 'running'; round: number; phase: 'review' | 'summary'; attempt: number }
  | { state: 'completed' | 'incomplete' | 'revision_failed'; outcome: Record<string, unknown> };

export function reviewCore(admin: SupabaseClient, actorId: string) {
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
    const cfg = config.parse(view.config);
    if (round === 1) return { sections: src.sections, ...evidenceRules(cfg, src.body) };
    const first = await opinionsOf(view, src, 1);
    const self = cfg.reviewers.indexOf(modelId ?? '');
    const disputed = disputedDecisions([...first.values()]);
    const responses = [...first.keys()].filter(index => index !== self)
      .flatMap(index => disputed.map(decision => ({ reviewer: reviewerLabel(index), decision })));
    return { sections: src.sections, debate: true, responses, ...evidenceRules(cfg, src.body) };
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
  /** Judges every saved, unjudged call of the review; returns every call of it that now has a verdict, so the daily
   * recovery can settle all of them, not only those on its listing page (#962 review). */
  async function rejudge(view: ReviewView, src: Source): Promise<string[]> {
    const judged = view.calls.filter(c => c.verdict !== null).map(c => c.callId);
    for (const call of view.calls.filter(c => c.verdict === null && c.dispatched)) {
      const text = await outputOf(call.callId);
      if (!text) continue;
      const step = view.steps.find(s => s.groupId === call.groupId)!;
      const verdict = await judgeText(view, src, call, step.round, text);
      const result = await admin.rpc('fusion_call_verdict', { p_actor_id: actorId, p_call_id: call.callId, p_verdict: verdict });
      if (result.error && !/FUSION_VERDICT_IMMUTABLE/.test(String(result.error.message))) throw new Error('FUSION_REVIEW_UNAVAILABLE');
      judged.push(call.callId);
    }
    return judged;
  }
  const contextOf = (view: ReviewView, src: Source): ReviewContext => ({ report: src.body, materials: view.materials,
    sections: src.sections, maxCharacters: src.maxCharacters, evidence: Boolean(config.parse(view.config).evidence), ...reviewLocale(view.config) });
  /** Round 1 as sent, and the summary at its deepest trimming (verdicts only, which claimStep can always fall back to). */
  function fitsWhenSent(view: ReviewView, src: Source, skill: Awaited<ReturnType<typeof readReviewSkill>>) {
    const context = contextOf(view, src);
    const cfg = config.parse(view.config);
    const verdictsOnly = (index: number) => ({ reviewer: reviewerLabel(index), opinion: {
      decisions: DECISIONS.map(decision => ({ decision, strongestCase: '', strongestAlternative: '', verdict: 'change' as const, basis: '' })),
      issues: [], dropped: 0 } });
    return fusionRequestBytes(reviewerRequest(skill, context)) <= phaseLimit(view, 'review')
      && fusionRequestBytes(summaryRequest(skill, context, cfg.reviewers.map((_, i) => verdictsOnly(i)), src.declared, frozenValues(view)))
        <= phaseLimit(view, 'summary');
  }
  /** What a phase's request may reach: the billing byte cap, and the size the consented estimate priced. */
  const phaseLimit = (view: ReviewView, phase: 'review' | 'debate' | 'summary') => {
    const priced = config.parse(view.config).requestBytes?.[phase];
    return Math.min(PAYG_PROFILE_MAX_BYTES, priced && priced > 0 ? priced : PAYG_PROFILE_MAX_BYTES);
  };
  /** The least trimming that fits the byte cap: 0 = full opinions; 1 = without replies and reasoning text; 2 = also only
   * critical and major issues; 3 = also no issues (the key-decision verdicts stay). */
  function fitted(build: (level: number) => FusionRequest, limit: number): FusionRequest {
    for (let level = 0; level < 3; level++) {
      const request = build(level);
      if (fusionRequestBytes(request) <= limit) return request;
    }
    return build(3);
  }
  const trimmed = (opinion: Opinion | null, level: number): Opinion | null => !opinion || level === 0 ? opinion : {
    decisions: opinion.decisions.map(d => level >= 1 ? { ...d, strongestCase: '', strongestAlternative: '', basis: '' } : d),
    issues: level >= 3 ? [] : level >= 2 ? opinion.issues.filter(i => i.severity !== 'minor') : opinion.issues,
    dropped: opinion.dropped };
  const phaseOf = (at: ReviewPosition) => at.phase === 'summary' ? 'summary' as const : at.round > 1 ? 'debate' as const : 'review' as const;
  /** The requests of the current position for these models, each within its phase's byte cap (#962 review). */
  async function buildMembers(view: ReviewView, src: Source, at: ReviewPosition, models: string[]): Promise<FusionMember[]> {
    const cfg = config.parse(view.config);
    const skill = await readReviewSkill(admin, cfg.skill as ReviewSkill);
    const context = contextOf(view, src);
    assertSnapshotSize(context.report, context.materials);
    let members: FusionMember[];
    if (at.phase === 'review' && at.round === 1) {
      members = models.map(modelId => ({ modelId, phase: 'fusion_review', request: reviewerRequest(skill, context, roleOf(cfg, modelId)) }));
    } else if (at.phase === 'review') {
      const first = await opinionsOf(view, src, 1);
      members = models.map(modelId => {
        const index = cfg.reviewers.indexOf(modelId);
        const others = [...first].filter(([other]) => other !== index).map(([other, opinion]) => ({ reviewer: reviewerLabel(other), opinion }));
        return { modelId, phase: 'fusion_review' as const, request: fitted(level => debateRequest(skill, context,
          trimmed(first.get(index) ?? null, level), others.map(o => ({ ...o, opinion: trimmed(o.opinion, level)! })),
          disputedDecisions([...first.values()]), roleOf(cfg, modelId)), phaseLimit(view, 'debate')) };
      });
    } else {
      const opinions = await finalOpinions(view, src);
      // Started with the evidence check: the summary gets the issues merged and checked by code (one level of trimming at a time).
      const request = (level: number) => cfg.evidence
        ? summaryRequestMerged(skill, context, mergeOpinions(opinions, { report: reportBodyText(src.body), sections: src.sections }),
          opinions, src.declared, frozenValues(view), level)
        : summaryRequest(skill, context, opinions.map(o => ({ ...o, opinion: trimmed(o.opinion, level)! })), src.declared, frozenValues(view));
      members = [{ modelId: cfg.summary, phase: 'fusion_summary', request: fitted(request, phaseLimit(view, 'summary')) }];
    }
    // Every request must fit the per-call billing byte cap as actually serialized (#962 review); a step that cannot fit
    // even fully trimmed is never claimed.
    const limit = phaseLimit(view, at.phase === 'summary' ? 'summary' : at.round > 1 ? 'debate' : 'review');
    if (members.some(member => fusionRequestBytes(member.request) > limit)) throw new Error('FUSION_INPUT_TOO_LARGE');
    return members;
  }
  /** After every call of a finished step: the next position or the end (FUSION-REVIEW §2.1/§2.2). */
  async function decide(view: ReviewView, src: Source, at: ReviewPosition): Promise<ReviewDecision> {
    const cfg = config.parse(view.config);
    if (at.phase === 'review' && at.round === 1) {
      const opinions = [...(await opinionsOf(view, src, 1)).values()];
      if (!opinions.length) return { state: 'incomplete', outcome: { kind: 'no_opinions' } };
      // Only the whole panel finding nothing ends here; a partial panel goes on to the summary (#962 review).
      if (opinions.length === cfg.reviewers.length
        && opinions.every(opinion => !opinion.issues.length && opinion.decisions.every(d => d.verdict === 'keep'))) {
        return { state: 'completed', outcome: { kind: 'no_change' } };
      }
      // Round 2 only on a real split over a key decision (Owner 2026-10-14): each reviewer answers the others.
      if (cfg.maxRounds >= 2 && opinions.length >= 2 && hasDisagreement(opinions)) return { state: 'running', round: 2, phase: 'review', attempt: 1 };
      return { state: 'running', round: 1, phase: 'summary', attempt: 1 };
    }
    if (at.phase === 'review') return { state: 'running', round: at.round, phase: 'summary', attempt: 1 };
    const passed = await passedRevision(view, src);
    // The revision is never re-reviewed by the panel (§8.1, Owner 2026-10-13 选 A): the user now chooses section by section
    // (Owner 2026-10-14); nothing reaches R14 until then. A revision that changes no section is no revision (refunded, 0294).
    return passed?.changedSections.length ? { state: 'completed', outcome: { kind: 'revised', debated: at.round > 1, reviewedByPanel: false,
      awaitingChoice: true } } : { state: passed ? 'completed' : 'revision_failed', outcome: { kind: passed ? 'no_change' : 'revision_failed' } };
  }
  return { readSource, frozenValues, outputOf, callsAt, passedRevision, revisionInput, opinionRules, opinionsOf, finalOpinions,
    judgeText, rejudge, contextOf, fitsWhenSent, phaseLimit, phaseOf, buildMembers, decide };
}
