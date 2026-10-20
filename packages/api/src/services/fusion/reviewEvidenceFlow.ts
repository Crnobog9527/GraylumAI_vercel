/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { reportBodyText } from '../../shared/reportData';
import { parseOpinion, type Opinion } from './hostChecks';
import type { ReviewView } from './reviewRecord';
import type { EvidenceReason } from './reviewEvidence';
import { mergeOpinions } from './reviewMerge';
import { reviewerLabel } from './reviewPrompts';
import type { ReviewerRole } from './reviewEvidence';

/** The frozen parts of a review's config this module reads (absent on reviews started before the evidence check). */
export type EvidenceConfig = { reviewers: string[]; evidence?: boolean | undefined; roles?: Array<ReviewerRole | null> | undefined };

/** The report text opinions are checked against, only for reviews started with the evidence check. */
export const evidenceRules = (cfg: Pick<EvidenceConfig, 'evidence'>, body: string): { report?: string } =>
  cfg.evidence ? { report: reportBodyText(body) } : {};

/** The angle of one reviewer seat, bound to its model and frozen with the review. */
export const roleOf = (cfg: EvidenceConfig, modelId: string): ReviewerRole | null => cfg.roles?.[cfg.reviewers.indexOf(modelId)] ?? null;

/**
 * What the evidence check held back, recomputed from the saved opinions and the reviewed report (it is deterministic, so it is
 * never stored and can never disagree with what the summary was given): per reason, per seat, and what only one seat raised.
 * `nothingPassed`: reviewers raised issues but none reached the summary (the owner's detail marks it).
 */
export function evidenceDetail(cfg: EvidenceConfig, view: ReviewView, src: { body: string; sections: string[] },
  outputs: Map<string, { body: string }>): { report?: string; evidence?: unknown } {
  if (!cfg.evidence) return {};
  const report = reportBodyText(src.body);
  // The opinions the summary got: each seat's debate answer when it gave one, else its round-1 opinion.
  const byRound = new Map<number, { round: number; opinion: Opinion }>();
  for (const call of view.calls.filter(c => c.phase === 'fusion_review' && ['usable', 'unjudged_saved'].includes(String(c.verdict)))) {
    const round = view.steps.find(s => s.groupId === call.groupId)?.round ?? 1;
    const index = cfg.reviewers.indexOf(call.modelId ?? '');
    const rules = { sections: src.sections, report, ...(round > 1 ? { debate: true } : {}) };
    const opinion = index >= 0 ? parseOpinion(outputs.get(call.callId)?.body ?? '', rules) : null;
    if (opinion && round > (byRound.get(index)?.round ?? 0)) byRound.set(index, { round, opinion });
  }
  const list = [...byRound].map(([index, item]) => ({ reviewer: reviewerLabel(index), opinion: item.opinion }));
  list.sort((a, b) => a.reviewer.localeCompare(b.reviewer));
  const merge = mergeOpinions(list, { report, sections: src.sections });
  const reasons: Record<EvidenceReason, number> = { ...merge.droppedEarlier };
  for (const item of merge.dropped) reasons[item.reason]++;
  return { report, evidence: { checked: true, raised: merge.raised, handedOver: merge.issues.length,
    dropped: { missingQuote: reasons.missing_quote, quoteNotInReport: reasons.quote_not_in_report, anchorMissing: reasons.anchor_missing },
    singleSeatIssues: merge.issues.filter(issue => issue.reviewers.length === 1).length,
    nothingPassed: merge.raised > 0 && merge.issues.length === 0 } };
}
