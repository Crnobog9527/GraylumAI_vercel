/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';
import type { JuryCaseReport, JuryArrival } from '@/components/landing/preview-jury/jury-case';
import { SEATS, type JuryDetail, type JuryEvent, type JuryPanel, type Seat } from '@/components/landing/preview-jury/jury-events';
import { firstSentence } from '@/components/landing/preview-jury/jury-adopt';
import type { ReaderSource } from '@/components/landing/preview-jury/jury-reader';

type Outputs = inferRouterOutputs<AppRouter>['fusionReview'];
export type RawDetail = Outputs['detail'];
export type RawEvents = Outputs['events'];
export type MineItem = Outputs['mine'][number];
export type RawPanel = Outputs['panel'];

/** Review states with nothing more to run (the backend's ENDED_STATES). */
export const ENDED = new Set(['stopped', 'interrupted', 'revision_failed', 'incomplete', 'completed']);
export const ACTIVE = new Set(['running', 'paused']);

const isSeat = (value: unknown): value is Seat => typeof value === 'string' && (SEATS as readonly string[]).includes(value);
const kindOf = (outcome: unknown) => (outcome && typeof outcome === 'object' && typeof (outcome as { kind?: unknown }).kind === 'string'
  ? (outcome as { kind: string }).kind : '');

/**
 * fusionReview.detail in the result page's shapes. The seats are the ones the server returns, in its order; only the
 * outcome object becomes its kind. The record never carries model names, only seats.
 */
export function toJuryDetail(raw: RawDetail): JuryDetail {
  return {
    reviewId: raw.reviewId, state: raw.state, outcome: kindOf(raw.outcome), revisionId: null,
    seats: raw.seats.filter(item => isSeat(item.seat)) as JuryDetail['seats'],
    summary: raw.summary as JuryDetail['summary'],
    adoption: recordedChoice(raw.adoption),
    awaitingChoice: raw.awaitingChoice,
  };
}

/** The reviewed report by chapter, as the result page reads it. Real reports have no reading aids yet. */
export function toReaderSource(raw: Pick<RawDetail, 'chapters'>): ReaderSource {
  return { chapters: raw.chapters.map(item => ({ title: item.section, number: '', name: item.section, body: item.body })) };
}

const excerpt = (texts: readonly string[]) => texts.map(text => firstSentence(text.replace(/\s+/g, ' ').trim())).filter(Boolean).join(' ');

/** The two report cards on the canvas: the reviewed report and, once there is one, the start of the revision. */
export function toCaseReport(raw: Pick<RawDetail, 'chapters' | 'summary'>, account: string): JuryCaseReport {
  const revised = raw.summary.sections.filter(item => item.changed && item.revised).map(item => item.revised ?? '');
  return {
    title: account ? `定位报告：${account}` : '你的定位报告',
    excerpt: excerpt(raw.chapters.slice(0, 2).map(item => item.body)),
    chapters: raw.chapters.length,
    revisedExcerpt: excerpt(revised.slice(0, 2)),
  };
}

const KNOWN = new Set<JuryEvent['type']>(['review_started', 'reviewer_started', 'decision', 'issue', 'reviewer_failed', 'disagreement',
  'response', 'summary_started', 'adjudication', 'revision_ready_for_choice', 'revision_failed', 'review_ended', 'adoption_done']);

/** The stored choice once recorded (a reservation is still in progress); a decline stays a decline after a reload. */
function recordedChoice(value: unknown): JuryDetail['adoption'] {
  const stored = value as { state?: string; decision?: string; versionId?: string | null; adopted?: string[]; kept?: string[] } | null;
  if (stored?.state !== 'recorded') return null;
  return { state: 'recorded', versionId: stored.versionId ?? null, adopted: stored.adopted ?? [], kept: stored.kept ?? [],
    ...(stored.decision === 'decline' ? { declined: true } : {}) };
}

/** Events the page can play: known types whose seats are seats the page draws. Anything else is skipped, not guessed. */
export function playableEvents(list: RawEvents['events']): JuryEvent[] {
  return list.filter(event => {
    if (!KNOWN.has(event.type as JuryEvent['type'])) return false;
    if ('reviewer' in event && event.reviewer !== undefined && !isSeat(event.reviewer)) return false;
    if (event.type === 'review_started') return Array.isArray(event.reviewers) && event.reviewers.every(isSeat);
    return true;
  }) as unknown as JuryEvent[];
}

/**
 * Adds what a poll newly returned as one arrival at the playback time it came in. Ids already received are dropped,
 * so the same list read again adds nothing. Returns the same array when nothing is new.
 */
export function appendArrival(arrivals: readonly JuryArrival[], events: readonly JuryEvent[], atMs: number): readonly JuryArrival[] {
  const seen = new Set(arrivals.flatMap(arrival => arrival.events.map(event => event.id)));
  const fresh = events.filter(event => !seen.has(event.id));
  return fresh.length ? [...arrivals, { atMs: Math.max(0, atMs), events: fresh }] : arrivals;
}

/** Seat names from fusionReview.panel, in the shape the prototype resolves (fallbacks for missing names). */
export const toPanel = (panel: Outputs['panel'] | undefined): JuryPanel | undefined => (panel ? {
  reviewers: panel.reviewers.filter(item => isSeat(item.seat)) as JuryPanel['reviewers'], summary: { seat: 'S', name: panel.summary.name },
} : undefined);

/** One line about how a review that cannot be chosen from ended, or null when the result page says it all. */
export function endedNotice(state: string, outcome: string): string | null {
  if (state === 'completed' && outcome === 'revised') return null;
  if (state === 'completed') return '评审团看完了，认为这份报告不需要修改。';
  if (state === 'revision_failed') return null; // the result page explains it and shows the opinions
  if (state === 'stopped' || state === 'interrupted') return '这次评审已经结束，没有生成修订稿；下面是结束前已经收到的意见。';
  if (outcome === 'input_too_large') return '报告和资料太长，评审没有开始，也没有扣费。';
  return '这次评审没有完成，没有生成修订稿；下面是已经收到的意见。';
}

/** fusionReview.start refusals in plain words. */
const START_ERROR: Record<string, string> = {
  FUSION_REVIEW_DISABLED: '评审团暂时没有开放。',
  FUSION_REVIEW_INCOMPLETE: '评审团暂时没有开放。',
  FUSION_BUDGET_EXCEEDED: '这份报告太长，超出了评审团单次的预算上限，暂时不能评审。',
  FUSION_MEMBERSHIP_REQUIRED: '评审团是会员功能，开通会员后可以使用。',
  REPORT_MEMBERSHIP_REQUIRED: '评审团是会员功能，开通会员后可以使用。',
  FUSION_REVIEW_ACTIVE: '你还有一个评审正在进行，等它结束后再开新的。',
  FUSION_REVIEW_BREAKER: '评审最近多次没有完成，暂时停用了，请稍后再试或联系客服。',
  FUSION_REVIEW_VERSION_BLOCKED: '这份报告连续 3 次评审没有完成，已暂停对它评审，请联系客服。',
  FUSION_REVIEW_STALE: '报告有更新，或者还没有生成定位报告。请刷新页面，生成报告后再试。',
  FUSION_REVIEW_CONFLICT: '没能开始评审，请刷新页面后再试。',
  FUSION_REVIEW_ESTIMATE_CHANGED: '模型价格刚刚有变化，最多消耗的积分也变了。请看一下新的数字，再决定要不要开始。',
  FUSION_INPUT_TOO_LARGE: '报告和资料太长，评审团一次读不完，暂时不能评审。',
  FUSION_REVIEW_CONTEXT: '报告和资料太长，评审团一次读不完，暂时不能评审。',
};
export const startErrorText = (code: string) => START_ERROR[code] ?? '没能开始评审，请稍后再试。';

/** The newest review of each draft (mine lists newest first). */
export function latestByDraft(items: readonly MineItem[]): Map<string, MineItem> {
  const latest = new Map<string, MineItem>();
  for (const item of items) if (!latest.has(item.draftId)) latest.set(item.draftId, item);
  return latest;
}

/** The sidebar mark of a draft's newest review: only while it runs, or while it waits for the chapter choices. */
export function draftMark(item: MineItem | undefined): { label: string; reviewId: string } | null {
  if (!item) return null;
  if (ACTIVE.has(item.state)) return { label: item.state === 'paused' ? '评审已暂停' : '评审中', reviewId: item.reviewId };
  if (item.awaitingChoice) return { label: '评审完成·待选择', reviewId: item.reviewId };
  return null;
}

export const reviewHref = (draftId: string, reviewId: string) => `/positioning/${draftId}/review/${reviewId}`;
