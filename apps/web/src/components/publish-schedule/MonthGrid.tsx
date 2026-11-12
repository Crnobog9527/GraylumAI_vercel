'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { platformName } from '@/components/publish-monitor/labels';
import {
  byDay, chipOf, dayKey, isToday, monthTitle, monthWeeks, MONTH_CHIPS, platformsLabel, shiftAnchor, startOfDay, WEEK_HEAD,
} from '@/lib/publish-schedule/calendar';
import { dayLabel, timeLabel, type ScheduleEntry } from '@/lib/publish-schedule/schedule-view';
import styles from './schedule-calendar.module.css';

/** The words a chip stands for (its title and what screen readers say): time, platforms, status, the caption's start. */
export function chipName(entry: ScheduleEntry): string {
  const { status } = chipOf(entry);
  const caption = entry.captionPreview ? `，${entry.captionPreview}` : '';
  return `${timeLabel(entry.at)} ${platformsLabel(entry, platformName)}，${status.label}${caption}`;
}

/** One post in a month cell: its colour bar, the time and the platforms in Chinese. */
export function EntryChip({ entry, onOpen }: { entry: ScheduleEntry; onOpen: (entry: ScheduleEntry) => void }) {
  const { tone } = chipOf(entry);
  const name = chipName(entry);
  return (
    <button type="button" className={`${styles.chip} ${styles.tone}`} data-tone={tone} title={name} aria-label={name} onClick={() => onOpen(entry)}>
      <time dateTime={entry.at}>{timeLabel(entry.at)}</time>
      <span className={styles.chipText}>{platformsLabel(entry, platformName)}</span>
    </button>
  );
}

/** The month: 4–6 weeks, Monday first; each day shows its first three posts, the rest are counted and open that week. */
export function MonthGrid({ anchor, entries, now, onOpen, onOpenDay }: {
  anchor: Date; entries: ScheduleEntry[]; now: Date; onOpen: (entry: ScheduleEntry) => void; onOpenDay: (day: Date) => void;
}) {
  const days = byDay(entries);
  return (
    <div className={styles.month} role="table" aria-label={`${monthTitle(anchor)}的发布`}>
      <div className={styles.weekHead} role="row">
        {WEEK_HEAD.map(name => <div key={name} role="columnheader">{name}</div>)}
      </div>
      <div className={styles.monthRows}>
        {monthWeeks(anchor).map(week => (
          <div key={week[0]!.toISOString()} className={styles.monthRow} role="row">
            {week.map(day => {
              const items = days.get(dayKey(day)) ?? [];
              const outside = day.getMonth() !== anchor.getMonth();
              const today = isToday(day, now);
              const hidden = items.length - MONTH_CHIPS;
              return (
                <div key={day.toISOString()} className={styles.cell} role="cell" data-outside={outside || undefined}
                  data-today={today || undefined} aria-label={`${dayLabel(day)}${today ? '（今天）' : ''}，${items.length} 条`}>
                  <button type="button" className={styles.dateButton} aria-label={`看 ${dayLabel(day)} 这一周`}
                    onClick={() => onOpenDay(day)}>{day.getDate() === 1 ? `${day.getMonth() + 1}月1日` : day.getDate()}</button>
                  {items.slice(0, hidden > 0 ? MONTH_CHIPS - 1 : MONTH_CHIPS)
                    .map(entry => <EntryChip key={entry.id} entry={entry} onOpen={onOpen} />)}
                  {hidden > 0 && <button type="button" className={styles.more} onClick={() => onOpenDay(day)}
                    aria-label={`${dayLabel(day)}还有 ${hidden + 1} 条，看这一周`}>还有 {hidden + 1} 条</button>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The small month on the side: pick any day to show it; today is dark, the week on screen is tinted, a dot marks posts. */
export function MiniMonth({ shown, entries, now, onPick }: {
  shown: Date[]; entries: ScheduleEntry[]; now: Date; onPick: (day: Date) => void;
}) {
  const [month, setMonth] = useState(() => startOfDay(shown[Math.floor(shown.length / 2)] ?? now));
  const [follow, setFollow] = useState(shown[0]?.getTime());
  // When the calendar moves to another page, the small month follows it again.
  if (shown[0] && shown[0].getTime() !== follow) {
    setFollow(shown[0].getTime());
    setMonth(startOfDay(shown[Math.floor(shown.length / 2)]!));
  }
  const busy = byDay(entries);
  // Only a week is tinted: tinting a whole month on screen would colour nearly every day.
  const first = shown.length <= 7 ? shown[0]?.getTime() ?? 0 : 0;
  const last = shown.length <= 7 ? shown[shown.length - 1]?.getTime() ?? -1 : -1;
  return (
    <section className={styles.mini} aria-label="选择日期">
      <div className={styles.miniHead}>
        <button type="button" className={styles.miniNav} aria-label="上个月" onClick={() => setMonth(m => shiftAnchor('month', m, -1))}>‹</button>
        <span aria-live="polite">{monthTitle(month)}</span>
        <button type="button" className={styles.miniNav} aria-label="下个月" onClick={() => setMonth(m => shiftAnchor('month', m, 1))}>›</button>
      </div>
      <div className={styles.miniGrid}>
        {WEEK_HEAD.map(name => <span key={name} aria-hidden>{name.slice(1)}</span>)}
        {monthWeeks(month).flat().map(day => (
          <button key={day.toISOString()} type="button" className={styles.miniDay} onClick={() => onPick(day)}
            aria-label={`${dayLabel(day)}${isToday(day, now) ? '（今天）' : ''}`} aria-current={isToday(day, now) ? 'date' : undefined}
            data-outside={day.getMonth() !== month.getMonth() || undefined} data-today={isToday(day, now) || undefined}
            data-shown={(day.getTime() >= first && day.getTime() <= last) || undefined}
            data-busy={busy.has(dayKey(day)) || undefined}>{day.getDate()}</button>
        ))}
      </div>
    </section>
  );
}
