/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  byDay, chipTone, dayKey, firstHour, HOUR_PX, monthWeeks, placeDay, platformsLabel, shiftAnchor, showsToday, viewDays,
  viewRange, viewTitle,
} from './calendar';
import { entryStatus, type ScheduleEntry } from './schedule-view';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).toISOString();
const job = (id: string, iso: string, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id, state: 'scheduled', at: iso,
  scheduledAt: iso, captionPreview: null, cancelReason: null, errorCode: null, manualReview: false, holdCredits: 6, chargedCredits: null,
  targets: [], ...extra });

describe('the month and week pages', () => {
  it('a month covers whole weeks from the Monday before the 1st to the Sunday after the last day', () => {
    // November 2026: the 1st is a Sunday, the 30th a Monday — six weeks, 26 October to 6 December.
    const weeks = monthWeeks(new Date(2026, 10, 18));
    expect(weeks).toHaveLength(6);
    expect(weeks[0]![0]).toEqual(new Date(2026, 9, 26));
    expect(weeks[5]![6]).toEqual(new Date(2026, 11, 6));
    // February 2027 starts on a Monday and has four weeks exactly.
    expect(monthWeeks(new Date(2027, 1, 10))).toHaveLength(4);
  });

  it('reads at most 42 local days (the server takes up to 43), and a week reads seven', () => {
    const month = viewRange('month', new Date(2026, 10, 18));
    expect(month).toEqual({ from: new Date(2026, 9, 26).toISOString(), to: new Date(2026, 11, 7).toISOString() });
    expect(Date.parse(month.to) - Date.parse(month.from)).toBeLessThan(43 * 86_400_000);
    expect(viewRange('week', new Date(2026, 10, 18))).toEqual({ from: new Date(2026, 10, 16).toISOString(),
      to: new Date(2026, 10, 23).toISOString() });
    expect(viewDays('week', new Date(2026, 10, 22))[0]).toEqual(new Date(2026, 10, 16));
  });

  it('moves a month (from the 31st too) or a week, and knows when today is already shown', () => {
    expect(shiftAnchor('month', new Date(2027, 0, 31), 1)).toEqual(new Date(2027, 1, 1));
    expect(shiftAnchor('month', new Date(2027, 0, 31), -1)).toEqual(new Date(2026, 11, 1));
    expect(shiftAnchor('week', new Date(2026, 10, 30), 1)).toEqual(new Date(2026, 11, 7));
    const today = new Date(2026, 10, 18, 9);
    expect(showsToday('month', new Date(2026, 10, 2), today)).toBe(true);
    expect(showsToday('month', new Date(2026, 11, 2), today)).toBe(false);
    expect(showsToday('week', new Date(2026, 10, 22), today)).toBe(true);
    expect(showsToday('week', new Date(2026, 10, 23), today)).toBe(false);
  });

  it('titles the month, and a week by its span across months and years', () => {
    expect(viewTitle('month', new Date(2026, 10, 18))).toBe('2026年11月');
    expect(viewTitle('week', new Date(2026, 10, 18))).toBe('2026年11月16日 – 22日');
    expect(viewTitle('week', new Date(2026, 11, 2))).toBe('2026年11月30日 – 12月6日');
    expect(viewTitle('week', new Date(2026, 11, 30))).toBe('2026年12月28日 – 2027年1月3日');
  });
});

describe('posts on the calendar', () => {
  it('groups posts by local day in time order', () => {
    const days = byDay([job('b', at(2026, 10, 18, 15)), job('a', at(2026, 10, 18, 9)), job('c', at(2026, 10, 19, 1))]);
    expect(days.get(dayKey(new Date(2026, 10, 18)))!.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(days.get(dayKey(new Date(2026, 10, 19)))!.map(entry => entry.id)).toEqual(['c']);
  });

  it('colours each status, scheduled blue apart from the ones under way', () => {
    expect(chipTone(entryStatus(job('a', at(2026, 10, 18))))).toBe('scheduled');
    expect(chipTone(entryStatus(job('a', at(2026, 10, 18), { state: 'unknown' })))).toBe('working');
    expect(chipTone(entryStatus(job('a', at(2026, 10, 18), { state: 'failed' })))).toBe('failed');
    expect(chipTone(entryStatus(job('a', at(2026, 10, 18), { state: 'released' })))).toBe('cancelled');
  });

  it('names the platforms in Chinese once each', () => {
    const entry = job('a', at(2026, 10, 18), { targets: [{ connectionId: 'c1', platform: 'douyin', status: 'pending' },
      { connectionId: 'c2', platform: 'xiaohongshu', status: 'pending' }, { connectionId: 'c3', platform: 'douyin', status: 'pending' }] });
    const names: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' };
    expect(platformsLabel(entry, p => names[p] ?? p)).toBe('抖音、小红书');
    expect(platformsLabel(job('b', at(2026, 10, 18)), p => p)).toBe('没有平台');
  });

  it('puts posts on the time axis; ones close together share the width, later ones get it back', () => {
    const placed = placeDay([job('a', at(2026, 10, 18, 9)), job('b', at(2026, 10, 18, 9, 20)), job('c', at(2026, 10, 18, 9, 55)),
      job('d', at(2026, 10, 18, 14))]);
    const by = Object.fromEntries(placed.map(item => [item.entry.id, item]));
    expect(by.a!.top).toBe(9 * HOUR_PX);
    expect([by.a!.column, by.a!.columns]).toEqual([0, 2]);
    expect([by.b!.column, by.b!.columns]).toEqual([1, 2]);
    // 9:55 starts after 9:00's card ends (50 minutes), so it takes the first column again in the same group.
    expect([by.c!.column, by.c!.columns]).toEqual([0, 2]);
    expect([by.d!.column, by.d!.columns]).toEqual([0, 1]);
  });

  it('opens the week axis an hour before an early post, else at 8:00', () => {
    expect(firstHour([])).toBe(8);
    expect(firstHour([job('a', at(2026, 10, 18, 6, 30))])).toBe(5);
    expect(firstHour([job('a', at(2026, 10, 18, 13))])).toBe(8);
  });
});
