/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Review-process events, shaped after FUSION-REVIEW.md §2.2a (fusionReview.events → { events, ended }, each with a fixed id).
 * The prototype only replays mock events of these shapes; nothing here calls the backend or a model.
 * Events carry only seat codes (A/B/C, the summary is S); names come from fusionReview.panel(), never from a model.
 */
export type Seat = 'A' | 'B' | 'C';
export type DecisionKey = 'positioning' | 'audience' | 'platform' | 'monetization';
export type Severity = 'critical' | 'major' | 'minor';
export type Verdict = 'keep' | 'change';

type Base = { id: string };

export type JuryEvent = Base & (
  | { type: 'review_started'; reviewers: Seat[]; sections: number }
  | { type: 'reviewer_started'; round: 1 | 2; reviewer: Seat }
  | {
    type: 'decision'; round: 1 | 2; reviewer: Seat; decision: DecisionKey;
    strongestCase: string; strongestAlternative: string; verdict: Verdict;
  }
  | { type: 'issue'; round: 1 | 2; reviewer: Seat; section: string; perspective: string; severity: Severity; problem: string }
  | { type: 'reviewer_failed'; round: 1 | 2; reviewer: Seat; reason: 'format' | 'no_delivery' | 'stopped' }
  | { type: 'disagreement'; decision: DecisionKey; keep: Seat[]; change: Seat[] }
  | { type: 'response'; round: 2; reviewer: Seat; to: Seat; strongestView: string; stance: 'agree' | 'disagree' }
  | { type: 'summary_started'; round: 1 | 2 }
  | { type: 'adjudication'; issue: string; reviewers: Seat[]; single: boolean; adopted: boolean; reason: string }
  | { type: 'revision_ready'; changedSections: number; changedFields: number; revisionId: string }
  | { type: 'revision_failed'; reason: string }
  | { type: 'review_ended'; state: string; outcome: string }
);

export type JuryEventType = JuryEvent['type'];

export type SeatCode = Seat | 'S';

/** fusionReview.panel(): display names set by an admin, unrelated to the models behind the seats. Up to 20 characters. */
export type JuryPanel = { reviewers: { seat: Seat; name: string }[]; summary: { seat: 'S'; name: string } };
export type JurySeatNames = Record<SeatCode, string>;

export const SEAT_NAME_MAX = 20;
export const SEATS: readonly Seat[] = ['A', 'B', 'C'];

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

export const VERDICT_LABEL: Record<Verdict, string> = { keep: '保留', change: '改' };

export const SEVERITY_LABEL: Record<Severity, string> = { critical: '关键', major: '重要', minor: '次要' };

export const FAILED_REASON_LABEL: Record<'format' | 'no_delivery' | 'stopped', string> = {
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
