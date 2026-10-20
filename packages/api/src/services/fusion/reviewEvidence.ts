/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * The evidence of a review issue, checked by code against the reviewed report (Owner 2026-10-20: a severe issue, and one
 * only one reviewer raised, must quote the report word for word, and the host checks that the quote is really there).
 * An issue about what the report LEAVES OUT cannot quote anything: it names, as its anchor, the chapter where the missing
 * content belongs, and the host checks that the chapter exists. Pure, deterministic: recomputed from saved opinions anywhere.
 */
/** The fixed seat angles (Owner 2026-10-20): money maths, evidence and benchmarks, what the user can actually carry out. */
export const REVIEWER_ROLES = ['finance', 'evidence', 'execution'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
export type IssueKind = 'content' | 'omission';
export type Evidence = 'quoted' | 'anchored' | 'unverified' | 'none';
export type EvidenceReason = 'missing_quote' | 'quote_not_in_report' | 'anchor_missing';
export const MIN_QUOTE_CHARACTERS = 6;

/** Whitespace, markdown marks and width variants do not count: a model copying a line may drop the "**" around it. */
export const normalizeText = (value: string) => value.normalize('NFKC').replace(/[\s*_`#>]+/g, '');
const title = (value: string) => value.replace(/^#+\s*/, '').trim();

/** What an issue's evidence is, against the report text and the template's chapter titles. */
export function evidenceOf(issue: { kind?: IssueKind; quote?: string; anchor?: string }, reportText: string, sections: string[]):
  { evidence: Evidence; reason: EvidenceReason | null } {
  if (issue.kind === 'omission') {
    const anchor = title(issue.anchor ?? '');
    return sections.includes(anchor) ? { evidence: 'anchored', reason: null } : { evidence: 'none', reason: 'anchor_missing' };
  }
  const quote = normalizeText(issue.quote ?? '');
  if (!quote.length) return { evidence: 'none', reason: 'missing_quote' };
  if ([...quote].length >= MIN_QUOTE_CHARACTERS && normalizeText(reportText).includes(quote)) return { evidence: 'quoted', reason: null };
  return { evidence: 'unverified', reason: 'quote_not_in_report' };
}

/** Two quotes point at the same place when one holds the other or they share a run of this many characters. */
const SHARED_RUN = 12;
export function quotesOverlap(a: string, b: string): boolean {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const chars = [...x];
  if (chars.length < SHARED_RUN) return false;
  const runs = new Set<string>();
  for (let i = 0; i + SHARED_RUN <= chars.length; i++) runs.add(chars.slice(i, i + SHARED_RUN).join(''));
  const other = [...y];
  for (let i = 0; i + SHARED_RUN <= other.length; i++) if (runs.has(other.slice(i, i + SHARED_RUN).join(''))) return true;
  return false;
}
