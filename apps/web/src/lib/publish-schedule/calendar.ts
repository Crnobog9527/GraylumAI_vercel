/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-SCHEDULE calendar helpers (Owner 2026-11-12: the schedule page looks like a desktop calendar, month first, with a
 * week time axis). All of it is local time in the viewer's browser; the server only gets the UTC range to read. Weeks start
 * on Monday, as the rest of the page does.
 */
import { entryStatus, sameLocalDay, weekDays, weekStart, type EntryStatus, type ScheduleEntry } from './schedule-view';

export type CalendarView = 'month' | 'week';

const day = (y: number, m: number, d: number) => new Date(y, m, d);
export const startOfDay = (date: Date) => day(date.getFullYear(), date.getMonth(), date.getDate());

/** The weeks shown for the month of `anchor`: from the Monday on or before the 1st to the Sunday on or after the last day. */
export function monthWeeks(anchor: Date): Date[][] {
  const first = day(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = day(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const weeks: Date[][] = [];
  for (let start = weekStart(first); start <= last; start = day(start.getFullYear(), start.getMonth(), start.getDate() + 7)) {
    weeks.push(weekDays(start));
  }
  return weeks;
}

/** The days the view covers (a month's 4–6 full weeks, or one week). */
export function viewDays(view: CalendarView, anchor: Date): Date[] {
  return view === 'month' ? monthWeeks(anchor).flat() : weekDays(weekStart(anchor));
}

/** The [from, to) range the view reads, as UTC instants. At most 42 local days, inside the server's 43-day limit. */
export function viewRange(view: CalendarView, anchor: Date): { from: string; to: string } {
  const days = viewDays(view, anchor);
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return { from: first.toISOString(), to: day(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString() };
}

/** The anchor one page before (-1) or after (+1): a month in the month view (day 1, so 31 Jan + 1 is February), else a week. */
export function shiftAnchor(view: CalendarView, anchor: Date, step: -1 | 1): Date {
  return view === 'month' ? day(anchor.getFullYear(), anchor.getMonth() + step, 1)
    : day(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + step * 7);
}

/** Whether the view around `anchor` already shows today (the 今天 button then has nothing to do). */
export function showsToday(view: CalendarView, anchor: Date, today: Date): boolean {
  if (view === 'month') return anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth();
  return sameLocalDay(weekStart(anchor), weekStart(today));
}

const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const WEEK_HEAD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const weekdayShort = (date: Date) => WEEKDAY_SHORT[date.getDay()]!;
export const monthTitle = (anchor: Date) => `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;

/** The toolbar title: the month, or the week's span ("2026年11月16日 – 22日", "2026年11月30日 – 12月6日"). */
export function viewTitle(view: CalendarView, anchor: Date): string {
  if (view === 'month') return monthTitle(anchor);
  const [first, last] = [weekDays(weekStart(anchor))[0]!, weekDays(weekStart(anchor))[6]!];
  const head = `${first.getFullYear()}年${first.getMonth() + 1}月${first.getDate()}日`;
  if (first.getFullYear() !== last.getFullYear()) return `${head} – ${last.getFullYear()}年${last.getMonth() + 1}月${last.getDate()}日`;
  return first.getMonth() === last.getMonth() ? `${head} – ${last.getDate()}日` : `${head} – ${last.getMonth() + 1}月${last.getDate()}日`;
}

/** Entries grouped by local day (key `dayKey`), each day in time order. */
export const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
export function byDay(entries: ScheduleEntry[]): Map<string, ScheduleEntry[]> {
  const days = new Map<string, ScheduleEntry[]>();
  for (const entry of [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))) {
    const key = dayKey(new Date(entry.at));
    days.set(key, [...(days.get(key) ?? []), entry]);
  }
  return days;
}

/** The chip colour of a status: scheduled is blue, anything still under way gold, then green, amber, red and grey. */
export type ChipTone = 'scheduled' | 'working' | 'done' | 'partial' | 'failed' | 'cancelled';
export function chipTone(status: EntryStatus): ChipTone {
  return status.tone === 'waiting' ? 'scheduled' : status.tone;
}
export const LEGEND: Array<{ tone: ChipTone; label: string }> = [
  { tone: 'scheduled', label: '已排期' }, { tone: 'working', label: '发布中' }, { tone: 'done', label: '已发布' },
  { tone: 'partial', label: '部分成功' }, { tone: 'failed', label: '失败' }, { tone: 'cancelled', label: '已取消' },
];

/** The platforms of one post in Chinese, joined ("小红书、抖音"); the name table is the caller's (#1904). */
export function platformsLabel(entry: ScheduleEntry, name: (platform: string) => string): string {
  const names = [...new Set(entry.targets.map(target => name(target.platform)))];
  return names.length ? names.join('、') : '没有平台';
}

/** One post as the calendar shows it: its local time, status and colour. */
export function chipOf(entry: ScheduleEntry) {
  const status = entryStatus(entry);
  return { status, tone: chipTone(status) };
}

/** Week time axis: one hour is HOUR_PX tall; a post's card covers CARD_MINUTES from its time. */
export const HOUR_PX = 56;
export const CARD_MINUTES = 50;
export const minutesOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes();

export type Placed = { entry: ScheduleEntry; top: number; column: number; columns: number };

/**
 * Where each post of one day sits on the time axis. Posts whose cards would overlap share the width: each gets the first free
 * column, and every post of an overlapping group is drawn as narrow as the group's widest row needs.
 */
export function placeDay(entries: ScheduleEntry[]): Placed[] {
  const sorted = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const close = () => { const columns = columnEnds.length; for (const item of group) item.columns = columns; };
  for (const entry of sorted) {
    const start = minutesOfDay(new Date(entry.at));
    if (start >= groupEnd) { close(); group = []; columnEnds = []; }
    let column = columnEnds.findIndex(end => end <= start);
    if (column < 0) { column = columnEnds.length; columnEnds.push(0); }
    columnEnds[column] = start + CARD_MINUTES;
    groupEnd = Math.max(groupEnd, start + CARD_MINUTES);
    const item = { entry, top: (start / 60) * HOUR_PX, column, columns: 1 };
    group.push(item);
    placed.push(item);
  }
  close();
  return placed;
}

/** The hour the week axis first scrolls to: an hour before the earliest post of the week, else 8:00. */
export function firstHour(entries: ScheduleEntry[]): number {
  if (!entries.length) return 8;
  const earliest = Math.min(...entries.map(entry => minutesOfDay(new Date(entry.at))));
  return Math.max(0, Math.min(8, Math.floor(earliest / 60) - 1));
}

/** In the month view a day shows at most this many chips; the rest are counted ("还有 2 条") and open the week. */
export const MONTH_CHIPS = 3;
export const isToday = (date: Date, now: Date) => sameLocalDay(date, now);
