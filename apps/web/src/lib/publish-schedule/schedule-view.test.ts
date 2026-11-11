/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  changeable, entriesOn, entryStatus, fromLocalInput, hasOpenEntries, scheduleErrorMessage, timeProblem, toLocalInput,
  weekDays, weekRange, weekStart, type ScheduleEntry,
} from './schedule-view';

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id: 'j1', state: 'scheduled',
  at: '2026-11-20T17:00:00.000Z', scheduledAt: '2026-11-20T17:00:00.000Z', captionPreview: '合成文案', cancelReason: null,
  errorCode: null, manualReview: false, holdCredits: 12, chargedCredits: null,
  targets: [{ connectionId: 'c1', platform: 'x', status: 'pending' }, { connectionId: 'c2', platform: 'youtube', status: 'pending' }],
  ...over });

describe('the week in local time', () => {
  it('starts on Monday at local midnight and has seven local days', () => {
    const start = weekStart(new Date(2026, 10, 15, 13, 30)); // Sunday 15 Nov 2026
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getDay(), start.getHours()]).toEqual([2026, 10, 9, 1, 0]);
    expect(weekStart(new Date(2026, 10, 16, 0, 5)).getDate()).toBe(16);
    expect(weekStart(new Date(2026, 10, 16), 1).getDate()).toBe(23);
    expect(weekDays(start).map(d => d.getDate())).toEqual([9, 10, 11, 12, 13, 14, 15]);
    const { from, to } = weekRange(start);
    expect(Date.parse(from)).toBe(start.getTime());
    expect(new Date(to).getDate()).toBe(16);
  });

  it('groups entries by the local day and in time order', () => {
    const day = new Date(2026, 10, 20);
    const late = entry({ id: 'late', at: new Date(2026, 10, 20, 21).toISOString() });
    const early = entry({ id: 'early', at: new Date(2026, 10, 20, 8).toISOString() });
    const other = entry({ id: 'other', at: new Date(2026, 10, 21, 8).toISOString() });
    expect(entriesOn([late, other, early], day).map(e => e.id)).toEqual(['early', 'late']);
  });

  it('converts the picker value from local time to a UTC instant and back', () => {
    const ms = new Date(2026, 10, 20, 9, 30).getTime();
    expect(toLocalInput(ms)).toBe('2026-11-20T09:30');
    expect(fromLocalInput('2026-11-20T09:30')).toBe(new Date(ms).toISOString());
    expect(fromLocalInput('20/11/2026 9:30')).toBeNull();
  });

  it('checks the same range as the server: 15 minutes to 30 days ahead', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(timeProblem(null, now)).toContain('请选择');
    expect(timeProblem('2026-11-11T12:10:00Z', now)).toContain('15 分钟');
    expect(timeProblem('2026-11-11T12:16:00Z', now)).toBeNull();
    expect(timeProblem('2026-12-12T12:00:00Z', now)).toContain('30 天');
  });
});

describe('what the page says about a post', () => {
  it('a scheduled post can be changed until 10 minutes before its time', () => {
    const at = Date.parse('2026-11-20T17:00:00.000Z');
    expect(changeable(entry(), at - 11 * 60_000)).toBe(true);
    expect(changeable(entry(), at - 9 * 60_000)).toBe(false);
    expect(changeable(entry({ cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' }), at - 3600_000)).toBe(false);
    expect(changeable(entry({ state: 'completed' }), at - 3600_000)).toBe(false);
  });

  it('labels every state with a fixed text, including why a post was cancelled', () => {
    expect(entryStatus(entry())).toMatchObject({ label: '已排期' });
    expect(entryStatus(entry()).detail).toContain('冻结 12 积分');
    expect(entryStatus(entry({ cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' })).label).toBe('正在取消');
    expect(entryStatus(entry({ state: 'unknown' })).label).toBe('发布中');
    expect(entryStatus(entry({ state: 'completed', chargedCredits: 6,
      targets: [{ connectionId: 'c1', platform: 'x', status: 'published' }, { connectionId: 'c2', platform: 'youtube', status: 'failed' }] })))
      .toMatchObject({ label: '部分成功' });
    expect(entryStatus(entry({ state: 'completed', errorCode: 'PUBLISH_SCHEDULE_SENT_AFTER_CANCEL' })).detail).toContain('没有扣积分');
    expect(entryStatus(entry({ state: 'failed' })).detail).toContain('全部退回');
    expect(entryStatus(entry({ state: 'released', cancelReason: 'PUBLISH_SCHEDULE_MEMBERSHIP_ENDED' })).detail)
      .toBe('因会员到期已取消，积分已全部退回。');
    expect(entryStatus(entry({ state: 'released', errorCode: 'PUBLISH_MONITOR_PROVIDER_REJECTED_400' })).detail)
      .toBe('这次没有发出，积分已全部退回。');
    expect(entryStatus(entry({ manualReview: true })).label).toBe('确认中');
  });

  it('maps refusals to readable texts, never raw server text', () => {
    expect(scheduleErrorMessage('PUBLISH_SCHEDULE_LOCKED')).toContain('10 分钟');
    expect(scheduleErrorMessage('SOMETHING_ELSE')).toBe('暂时没有完成，请稍后重试。');
    expect(scheduleErrorMessage(undefined, 'TOO_MANY_REQUESTS')).toContain('稍后再试');
  });

  it('re-reads the list while something is waiting', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(hasOpenEntries([entry({ state: 'completed' })], now)).toBe(false);
    expect(hasOpenEntries([entry()], now)).toBe(true);
    expect(hasOpenEntries([entry({ scheduledAt: '2026-11-25T12:00:00Z' })], now)).toBe(false);
    expect(hasOpenEntries([entry({ state: 'unknown' })], now)).toBe(true);
  });
});
