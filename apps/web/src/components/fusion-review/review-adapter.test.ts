import { describe, expect, it } from 'vitest';
import {
  appendArrival, draftMark, endedNotice, feeText, latestByDraft, playableEvents, startErrorText, toJuryDetail, toReaderSource, type MineItem, type RawDetail,
  type RawEvents,
} from './review-adapter';

const item = (draftId: string, state: string, extra: Partial<MineItem> = {}): MineItem => ({ reviewId: `${draftId}-${state}`, draftId,
  sourceVersionId: 'v', state: state as MineItem['state'], round: 1, phase: 'review', outcomeKind: null, awaitingChoice: false,
  createdAt: '2026-10-16T00:00:00Z', endedAt: null, seenAt: null, ...extra });

describe('review page data', () => {
  it('marks a draft only while its newest review runs, pauses or waits for the chapter choice', () => {
    const latest = latestByDraft([item('d1', 'running'), item('d1', 'completed'), item('d2', 'completed', { awaitingChoice: true }),
      item('d3', 'completed')]);
    expect(draftMark(latest.get('d1'))).toEqual({ label: '评审中', reviewId: 'd1-running' });
    expect(draftMark(latest.get('d2'))?.label).toBe('评审完成·待选择');
    expect(draftMark(item('d4', 'paused'))?.label).toBe('评审已暂停');
    expect(draftMark(latest.get('d3'))).toBeNull();
    expect(draftMark(undefined)).toBeNull();
  });

  it('adds each event once, at the playback time its poll came in', () => {
    const a = { id: 'a', type: 'summary_started', round: 1 } as const;
    const b = { id: 'b', type: 'summary_started', round: 2 } as const;
    const first = appendArrival([], [a], 0);
    const second = appendArrival(first, [a, b], 9_000);
    expect(second).toEqual([{ atMs: 0, events: [a] }, { atMs: 9_000, events: [b] }]);
    expect(appendArrival(second, [a, b], 12_000)).toBe(second);
  });

  it('plays only known events about seats the page draws', () => {
    const list = [
      { id: '1', type: 'review_started', reviewers: ['A', 'B', 'C'], sections: 13 },
      { id: '2', type: 'reviewer_started', round: 1, reviewer: 'D' },
      { id: '3', type: 'something_new' },
      { id: '4', type: 'reviewer_started', round: 1, reviewer: 'B' },
    ] as RawEvents['events'];
    expect(playableEvents(list).map(event => event.id)).toEqual(['1', '4']);
  });

  it('reads the outcome kind, keeps only a recorded choice, and turns chapters into the reader\'s report', () => {
    const raw = { reviewId: 'r', draftId: 'd', state: 'completed', outcome: { kind: 'revised', debated: true }, seats: [{ seat: 'A', rounds: [] }],
      summary: { status: 'usable', sections: [] }, adoption: { state: 'reserved' }, awaitingChoice: true,
      chapters: [{ section: '定位', body: '正文。' }], preamble: '' } as unknown as RawDetail;
    expect(toJuryDetail(raw)).toMatchObject({ outcome: 'revised', adoption: null, awaitingChoice: true, seats: [{ seat: 'A' }] });
    expect(toReaderSource(raw).chapters).toEqual([{ title: '定位', number: '', name: '定位', body: '正文。' }]);
    expect(toReaderSource({ ...raw, preamble: '# 定位报告' }).chapters.map(item => item.title)).toEqual(['报告开头', '定位']);
    // A declined choice and a refused one stay what they were after a reload; a refusal is not "everything kept".
    expect(toJuryDetail({ ...raw, adoption: { state: 'recorded', decision: 'decline', adopted: [], kept: ['定位'] } } as unknown as RawDetail)
      .adoption).toMatchObject({ declined: true });
    expect(toJuryDetail({ ...raw, adoption: { state: 'recorded', decision: 'refused', refusal: 'REPORT_REVISION_STALE', adopted: [],
      kept: ['定位'] } } as unknown as RawDetail).adoption).toMatchObject({ refused: 'REPORT_REVISION_STALE', versionId: null });
  });

  it('says how a review ended in plain words, and why a start was refused', () => {
    expect(endedNotice('completed', 'revised')).toBeNull();
    expect(endedNotice('completed', 'no_change')).toBeNull(); // the result page says it
    expect(endedNotice('incomplete', 'input_too_large')).toContain('没有扣费');
    expect(endedNotice('stopped', '')).toContain('已经结束');
    expect(startErrorText('FUSION_REVIEW_ACTIVE')).toContain('正在进行');
    expect(startErrorText('SOMETHING_ELSE')).toBe('没能开始评审，请稍后再试。');
  });
});

describe('fixed-price charge line (0294)', () => {
  const fee = (state: 'held' | 'charged' | 'refunded', chargedCredits: number | null, reason: string | null) =>
    ({ credits: 1500, state, chargedCredits, reason });
  it('says what the review actually cost', () => {
    expect(feeText(fee('charged', 1500, 'revised'))).toBe('本次评审实际扣了 1,500 积分。');
    expect(feeText(fee('refunded', 0, 'incomplete'))).toBe('没有生成修订稿，1,500 积分已全额退回。');
    expect(feeText(fee('charged', 120, 'stopped'))).toBe('评审中途结束，按已经发出的部分实际扣了 120 积分（本次评审价格 1,500 积分）。');
    expect(feeText(fee('held', null, null))).toMatch(/还在结算/);
  });
  it('shows nothing for a review started before the fixed price', () => {
    expect(feeText(null)).toBeNull();
    expect(feeText(undefined)).toBeNull();
  });
});
