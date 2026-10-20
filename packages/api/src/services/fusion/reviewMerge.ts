/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Opinion } from './hostChecks';
import { evidenceOf, quotesOverlap, similarProblems, type Evidence, type EvidenceReason, type IssueKind } from './reviewEvidence';

/**
 * Round 1's issues, merged by code before the summary sees them (Owner 2026-10-20: "用代码合并去重第 1 轮意见，再交给汇总").
 * Issues of the same chapter whose verified quotes overlap are one issue raised by several seats. Omission issues, and issues
 * without a verified quote, are never merged: that cannot be decided reliably by code, and an unmerged duplicate costs the
 * summary a line while a wrong merge would lose an issue. An issue only one seat raised must carry checkable evidence
 * (a quote found in the report, or an omission anchored at a real chapter), else it is not handed to the summary and is counted.
 */
export type MergedIssue = {
  section: string; severity: 'critical' | 'major' | 'minor'; kind: IssueKind; reviewers: string[]; evidence: Evidence;
  quotes: string[]; anchor: string | null;
  views: Array<{ reviewer: string; perspective: string; problem: string; suggestion: string }>;
};
export type Dropped = { reviewer: string; section: string; reason: EvidenceReason; severity: string; why: 'severe' | 'single' };
export type MergeResult = { issues: MergedIssue[]; dropped: Dropped[]; raised: number;
  /** Severe issues already dropped when each opinion was judged (no checkable evidence), by reason. */
  droppedEarlier: Record<EvidenceReason, number> };

/** A chapter written as `定位` or `## 定位` is the same chapter. */
const name = (value: string) => value.replace(/^#+\s*/, '').trim();
const RANK = { critical: 0, major: 1, minor: 2 } as const;

export function mergeOpinions(opinions: Array<{ reviewer: string; opinion: Opinion }>, context: { report: string; sections: string[] }): MergeResult {
  type Item = { reviewer: string; issue: Opinion['issues'][number] };
  const items: Item[] = opinions.flatMap(({ reviewer, opinion }) => opinion.issues.map(issue => ({ reviewer, issue })));
  const droppedEarlier: Record<EvidenceReason, number> = { missing_quote: 0, quote_not_in_report: 0, anchor_missing: 0 };
  for (const { opinion } of opinions) {
    for (const reason of Object.keys(droppedEarlier) as EvidenceReason[]) droppedEarlier[reason] += opinion.droppedBy?.[reason] ?? 0;
  }
  const groups: Item[][] = [];
  for (const item of items) {
    const verified = (item.issue.evidence ?? evidenceOf(item.issue, context.report, context.sections).evidence) === 'quoted' && item.issue.kind !== 'omission';
    const home = verified ? groups.find(group => name(group[0]!.issue.location) === name(item.issue.location) && group.some(other =>
      other.issue.kind !== 'omission' && other.issue.evidence === 'quoted' && quotesOverlap(other.issue.quote, item.issue.quote))) : undefined;
    if (home) home.push(item); else groups.push([item]);
  }
  const merged: MergedIssue[] = [];
  const dropped: Dropped[] = [];
  for (const group of groups) {
    const reviewers = [...new Set(group.map(item => item.reviewer))];
    const first = group[0]!.issue;
    const evidence = group.map(item => item.issue.evidence ?? evidenceOf(item.issue, context.report, context.sections).evidence)
      .find(value => value === 'quoted' || value === 'anchored') ?? 'none';
    // Corroboration: another seat raised the same problem (same chapter and kind, same anchor for omissions, and a problem
    // text that is the same by the deterministic similarity rule). An unrelated issue in the same chapter proves nothing.
    const same = (other: Item) => name(other.issue.location) === name(first.location) && other.issue.kind === first.kind
      && (first.kind !== 'omission' || name(other.issue.anchor) === name(first.anchor))
      && similarProblems(other.issue.problem, first.problem);
    const corroborated = items.some(other => other.reviewer !== reviewers[0] && same(other));
    if (reviewers.length === 1 && !corroborated && evidence !== 'quoted' && evidence !== 'anchored') {
      const { reason } = evidenceOf(first, context.report, context.sections);
      dropped.push({ reviewer: reviewers[0]!, section: first.location.replace(/^#+\s*/, '').trim(),
        reason: reason ?? 'missing_quote', severity: first.severity, why: 'single' });
      continue;
    }
    merged.push({
      section: first.location.replace(/^#+\s*/, '').trim(), kind: first.kind,
      severity: group.map(item => item.issue.severity).sort((a, b) => RANK[a] - RANK[b])[0]!, reviewers, evidence,
      quotes: [...new Set(group.filter(item => item.issue.evidence === 'quoted').map(item => item.issue.quote.trim()))],
      anchor: first.kind === 'omission' ? first.anchor.replace(/^#+\s*/, '').trim() : null,
      views: group.map(item => ({ reviewer: item.reviewer, perspective: item.issue.perspective, problem: item.issue.problem,
        suggestion: item.issue.suggestion })),
    });
  }
  const order = (section: string) => { const at = context.sections.indexOf(section); return at < 0 ? context.sections.length : at; };
  merged.sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.section) - order(b.section));
  return { issues: merged, dropped, raised: items.length + Object.values(droppedEarlier).reduce((total, count) => total + count, 0), droppedEarlier };
}
