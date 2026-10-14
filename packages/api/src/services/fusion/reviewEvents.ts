/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DECISIONS, checkRevision, parseOpinion, type Opinion, type RevisionInput } from './hostChecks';
import { reviewerLabel } from './reviewPrompts';
import type { ReviewView } from './reviewRecord';

/** Progress events for the review animation (FUSION-REVIEW §2.2a, Owner 2026-10-14). Derived only from the
 * review record and saved, judged outputs: no event without real data. Each event has a stable id; the list is
 * ordered by the database times of the calls, and a client plays the ids it has not seen yet. Text is a summary
 * of at most SUMMARY_LIMIT characters; reviewers appear only as seats A/B/C and the summary as seat S. */
export const SUMMARY_LIMIT = 120;
export type ReviewEvent = { id: string; type: string; round?: number; reviewer?: string } & Record<string, unknown>;

const clip = (value: string) => {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  return chars.length <= SUMMARY_LIMIT ? chars.join('') : chars.slice(0, SUMMARY_LIMIT - 1).join('') + '…';
};
const FAILURE: Record<string, string> = { format_invalid: 'format', revision_invalid: 'format', no_delivery: 'no_delivery',
  user_stopped: 'stopped', erased_before_verdict: 'stopped' };
const USABLE = new Set(['usable', 'unjudged_saved']);

export function reviewEvents(input: { view: ReviewView; reviewers: string[]; sections: string[];
  /** Saved bodies of judged calls, by call id. */
  outputs: Map<string, string>; revision: RevisionInput }): { events: ReviewEvent[]; ended: boolean } {
  const { view, reviewers, sections, outputs } = input;
  const timed: Array<{ at: string; order: number; event: ReviewEvent }> = [];
  let order = 0;
  const add = (at: string | null | undefined, event: ReviewEvent) => { if (at !== undefined && at !== null) timed.push({ at, order: order++, event }); };
  const stepOf = (groupId: string) => view.steps.find(step => step.groupId === groupId);
  add('', { id: 'review_started', type: 'review_started', reviewers: reviewers.map((_, i) => reviewerLabel(i)), sections: sections.length });
  const firstRound = new Map<number, Opinion>();
  for (const call of view.calls) {
    const step = stepOf(call.groupId);
    if (!step) continue;
    const round = step.round;
    if (call.phase === 'fusion_summary') {
      add(call.dispatchedAt, { id: `summary_started:${round}`, type: 'summary_started', round });
      const text = call.verdict && USABLE.has(call.verdict) ? outputs.get(call.callId) : undefined;
      const adjudication = text ? adjudicationOf(text) : [];
      adjudication.forEach((item, i) => add(call.settledAt, { id: `adjudication:${round}:${i}`, type: 'adjudication',
        issue: clip(item.issue), reviewers: item.reviewers.filter(r => /^[A-C]$/.test(r)), single: item.single, adopted: item.adopted,
        reason: clip(item.reason) }));
      continue;
    }
    const index = reviewers.indexOf(call.modelId ?? '');
    if (index < 0) continue;
    const reviewer = reviewerLabel(index);
    add(call.dispatchedAt, { id: `reviewer_started:${round}:${reviewer}`, type: 'reviewer_started', round, reviewer });
    if (!call.verdict) continue;
    const opinion = USABLE.has(call.verdict) ? parseOpinion(outputs.get(call.callId) ?? '', { sections, debate: round > 1 }) : null;
    if (!opinion) {
      add(call.settledAt, { id: `reviewer_failed:${round}:${reviewer}`, type: 'reviewer_failed', round, reviewer,
        reason: FAILURE[call.verdict] ?? 'format' });
      continue;
    }
    if (round === 1) firstRound.set(index, opinion);
    for (const d of opinion.decisions) add(call.settledAt, { id: `decision:${round}:${reviewer}:${d.decision}`, type: 'decision', round,
      reviewer, decision: d.decision, strongestCase: clip(d.strongestCase), strongestAlternative: clip(d.strongestAlternative), verdict: d.verdict });
    opinion.issues.forEach((issue, i) => add(call.settledAt, { id: `issue:${round}:${reviewer}:${i}`, type: 'issue', round, reviewer,
      section: issue.location.replace(/^#+\s*/, '').trim(), perspective: clip(issue.perspective), severity: issue.severity,
      problem: clip(issue.problem) }));
    for (const response of opinion.responses ?? []) {
      if (!/^[A-C]$/.test(response.reviewer) || response.reviewer === reviewer) continue;
      add(call.settledAt, { id: `response:${reviewer}:${response.reviewer}`, type: 'response', round, reviewer, to: response.reviewer,
        strongestView: clip(response.strongestView), stance: response.stance });
    }
  }
  // The split that opened the debate round: shown when that round was claimed.
  const debate = view.steps.find(step => step.round === 2 && step.phase === 'review');
  if (debate) {
    for (const decision of DECISIONS) {
      const keep: string[] = [], change: string[] = [];
      for (const [index, opinion] of [...firstRound].sort(([a], [b]) => a - b)) {
        const verdict = opinion.decisions.find(d => d.decision === decision)?.verdict;
        (verdict === 'keep' ? keep : change).push(reviewerLabel(index));
      }
      if (keep.length && change.length) add(debate.claimedAt, { id: `disagreement:${decision}`, type: 'disagreement', decision, keep, change });
    }
  }
  if (view.endedAt) {
    const summary = view.calls.find(call => call.phase === 'fusion_summary' && call.verdict);
    if (view.state === 'revision_failed' && summary) {
      const text = outputs.get(summary.callId);
      const check = text ? checkRevision(text, input.revision) : null;
      add(view.endedAt, { id: 'revision_failed', type: 'revision_failed', reason: check && !check.ok ? check.reason
        : FAILURE[String(summary.verdict)] ?? 'REVISION_FORMAT' });
    }
    if (view.state === 'completed' && view.revisionId && summary) {
      const check = checkRevision(outputs.get(summary.callId) ?? '', input.revision);
      if (check.ok) add(view.endedAt, { id: 'revision_ready', type: 'revision_ready', revisionId: view.revisionId,
        changedSections: check.changedSections.length,
        changedFields: Object.values(check.r14Fields).reduce((n, fields) => n + Object.keys(fields).length, 0) });
    }
    add(view.endedAt, { id: 'review_ended', type: 'review_ended', state: view.state, outcome: view.outcome });
  }
  // Database times order the events; ties keep the derivation order (seat, then item).
  timed.sort((a, b) => (a.at === b.at ? a.order - b.order : Date.parse(a.at || '1970-01-01') - Date.parse(b.at || '1970-01-01')));
  return { events: timed.map(item => item.event), ended: Boolean(view.endedAt) };
}

function adjudicationOf(text: string): Array<{ issue: string; reviewers: string[]; single: boolean; adopted: boolean; reason: string }> {
  try {
    const value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { adjudication?: unknown };
    if (!Array.isArray(value.adjudication)) return [];
    return value.adjudication.filter((item): item is { issue: string; reviewers: string[]; single: boolean; adopted: boolean; reason: string } =>
      Boolean(item) && typeof item.issue === 'string' && Array.isArray(item.reviewers) && typeof item.single === 'boolean'
      && typeof item.adopted === 'boolean' && typeof item.reason === 'string').slice(0, 100);
  } catch { return []; }
}
