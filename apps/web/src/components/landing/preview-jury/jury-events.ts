/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Shapes of FUSION-REVIEW.md §2.2a (contract v6): the process events of fusionReview.events (summaries, ≤120 chars)
 * and the owner-only full text of fusionReview.detail. The prototype replays mock data of these shapes; nothing here
 * calls the backend or a model. Only seat codes appear (A/B/C, the summary is S); names come from fusionReview.panel().
 */
export type Seat = 'A' | 'B' | 'C';
export type SeatCode = Seat | 'S';
export type DecisionKey = 'positioning' | 'audience' | 'platform' | 'monetization';
export type Severity = 'critical' | 'major' | 'minor';
export type Verdict = 'keep' | 'change';
export type Stance = 'agree' | 'disagree';
export type FailedReason = 'format' | 'no_delivery' | 'stopped';

type Base = { id: string };

export type JuryEvent = Base & (
  | { type: 'review_started'; reviewers: Seat[]; sections: number }
  | { type: 'reviewer_started'; round: 1 | 2; reviewer: Seat }
  | {
    type: 'decision'; round: 1 | 2; reviewer: Seat; decision: DecisionKey;
    strongestCase: string; strongestAlternative: string; verdict: Verdict;
  }
  | {
    type: 'issue'; round: 1 | 2; reviewer: Seat; section: string; perspective: string; severity: Severity;
    /** Why it is a problem. */ problem: string; /** How to fix it. */ fix: string;
  }
  | { type: 'reviewer_failed'; round: 1 | 2; reviewer: Seat; reason: FailedReason }
  | { type: 'disagreement'; decision: DecisionKey; keep: Seat[]; change: Seat[] }
  | { type: 'response'; round: 2; reviewer: Seat; to: Seat; decision: DecisionKey; strongestView: string; stance: Stance }
  | { type: 'summary_started'; round: 1 | 2 }
  | ({ type: 'adjudication' } & RulingFields)
  | {
    type: 'revision_ready_for_choice'; changedSections: number; changedSectionTitles: string[]; changedFields: number;
  }
  | { type: 'revision_failed'; reason: string }
  | { type: 'review_ended'; state: string; outcome: string }
  /** After the user chose, chapter by chapter, between the revision and the original (fusionReview.adopt). */
  | { type: 'adoption_done'; adoptedSections: string[]; keptSections: string[]; versionId: string | null }
);

export type JuryEventType = JuryEvent['type'];
export type EventOf<T extends JuryEventType> = Extract<JuryEvent, { type: T }>;

/** One ruling of the summary: the panel's final opinion on one point, why, and how to change the report. */
export type RulingFields = {
  section: string; issue: string; reviewers: Seat[]; single: boolean; disputed: boolean;
  opinion: string; reason: string; fix: string; adopted: boolean;
};

/* ---- fusionReview.detail({ reviewId }): owner-only, full text, never truncated ---- */

export type DetailDecision = {
  decision: DecisionKey; strongestCase: string; strongestAlternative: string; verdict: Verdict; basis: string;
};
export type DetailIssue = { location: string; perspective: string; problem: string; suggestion: string; severity: Severity };
export type DetailResponse = { reviewer: Seat; decision: DecisionKey; strongestView: string; stance: Stance; reason: string };
export type DetailRound = {
  round: 1 | 2; status: 'usable' | 'failed' | 'pending';
  decisions?: DetailDecision[]; issues?: DetailIssue[]; responses?: DetailResponse[];
};
export type FieldChange = { stepId: string; fieldId: string; before: string; after: string };
export type DetailSection = {
  section: string; changed: boolean; rulings: RulingFields[];
  /** Only the wording changed: adopting it asks the user to confirm no positioning fact changed. */
  wordingOnly: boolean;
  /** Full text, only for changed chapters (the original comes from the frozen review version). */
  original?: string; revised?: string; fields: FieldChange[];
  /** Chapters that share a changed field with this one and must take the same choice. */
  linkedSections: string[];
};
export type AdoptChoice = { section: string; use: 'revised' | 'original'; confirmedNoFactChange?: boolean };
/** fusionReview.confirmAdoption's answer, or adopt's when every chapter keeps the original: the choice is recorded. */
export type AdoptRecorded = { state: 'recorded'; versionId: string | null; adopted: string[]; kept: string[];
  /** The user looked at the field changes and gave up the revision (confirmAdoption decline): nothing changed. */
  declined?: boolean;
  /** The adoption was refused for good (e.g. the report changed after the review): the refusal code; nothing changed. */
  refused?: string };
type FieldState = { value: string; status: string };
/** R14's field diff: what the adopted chapters change, and the later steps confirmed together with them. */
export type RevisionDiff = {
  changes: { stepId: string; stepTitle: string; fieldId: string; fieldTitle: string; before: FieldState; after: FieldState }[];
  cascade: { stepId: string; stepTitle: string; fields: { fieldId: string; fieldTitle: string; before: FieldState; after: FieldState }[] }[];
};
/** fusionReview.adopt with at least one adopted chapter: a proposal to show before confirming; nothing changed yet. */
export type AdoptProposed = { state: 'proposed'; revisionId: string; diff: RevisionDiff; diffHash: string; adopted: string[]; kept: string[] };
export type JuryDetail = {
  reviewId: string; state: string; outcome: string; revisionId: string | null;
  seats: { seat: Seat; rounds: DetailRound[] }[];
  summary: { status: 'usable' | 'failed' | 'none'; sections: DetailSection[] };
  /** The user's chapter choices once made (fusionReview.adopt can be called once), otherwise null. */
  adoption: AdoptRecorded | null;
  /** The review has ended and waits for the chapter choices; the draft is not locked meanwhile. */
  awaitingChoice: boolean;
  /** What the server's evidence check held back (reviews started with it); absent on the demo and older reviews. */
  evidence?: { checked: boolean; raised?: number; handedOver?: number; nothingPassed?: boolean;
    dropped?: { missingQuote: number; quoteNotInReport: number; anchorMissing: number } };
};

/* ---- fusionReview.panel(): display names set by an admin, unrelated to the models behind the seats ---- */

export type JuryPanel = { reviewers: { seat: Seat; name: string }[]; summary: { seat: 'S'; name: string } };
export type JurySeatNames = Record<SeatCode, string>;

export const SEAT_NAME_MAX = 20;
export const SEATS: readonly Seat[] = ['A', 'B', 'C'];
export const SUMMARY_TEXT_MAX = 120;

export const DEFAULT_SEAT_NAMES: JurySeatNames = { A: '评审 A', B: '评审 B', C: '评审 C', S: '汇总' };

/** Shown by the "示例名字" switch to prove names are configurable; A's name is the 20-character maximum. */
export const SAMPLE_PANEL: JuryPanel = {
  reviewers: [
    { seat: 'A', name: '专门挑刺的资深短视频运营与商业变现老顾问' },
    { seat: 'B', name: '较真的目标观众代表' },
    { seat: 'C', name: '看重落地的内容策略师' },
  ],
  summary: { seat: 'S', name: '首席主笔' },
};

export const DECISIONS: readonly DecisionKey[] = ['positioning', 'audience', 'platform', 'monetization'];

export const DECISION_LABEL: Record<DecisionKey, string> = {
  positioning: '定位',
  audience: '受众',
  platform: '平台',
  monetization: '变现路径',
};

export const VERDICT_LABEL: Record<Verdict, string> = { keep: '保留', change: '要改' };
export const STANCE_LABEL: Record<Stance, string> = { agree: '被说服了', disagree: '仍不同意' };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: '关键', major: '重要', minor: '次要' };

export const FAILED_REASON_LABEL: Record<FailedReason, string> = {
  format: '回答格式不合格，这位评审的意见不计入',
  no_delivery: '没有收到这位评审的回答',
  stopped: '这位评审已停止',
};

/** Host check codes of revision_failed, in plain words. Unknown codes fall back to the generic line. */
const REVISION_FAILED_LABEL: Record<string, string> = {
  REVISION_NOTES: '修订稿的修改说明和实际改动对不上',
  REVISION_SECTIONS: '修订稿缺少报告里原有的章节',
  REVISION_FIELDS: '修订稿漏掉了定位里的字段',
};

export function revisionFailedLabel(code: string): string {
  return REVISION_FAILED_LABEL[code] ?? '修订稿没有通过检查';
}

/** Names come from the panel; a missing, empty or over-long name falls back to the seat's default name. */
export function resolveSeatNames(panel: JuryPanel | undefined): JurySeatNames {
  const given = new Map<SeatCode, string>([...(panel?.reviewers ?? []), ...(panel ? [panel.summary] : [])]
    .map(entry => [entry.seat, entry.name.trim()]));
  const pick = (seat: SeatCode) => {
    const name = given.get(seat);
    return name && Array.from(name).length <= SEAT_NAME_MAX ? name : DEFAULT_SEAT_NAMES[seat];
  };
  return { A: pick('A'), B: pick('B'), C: pick('C'), S: pick('S') };
}

/** The event list's text rule: at most 120 characters, cut ones end with "…". */
export function summarize(text: string): string {
  const chars = Array.from(text);
  return chars.length <= SUMMARY_TEXT_MAX ? text : `${chars.slice(0, SUMMARY_TEXT_MAX - 1).join('')}…`;
}
