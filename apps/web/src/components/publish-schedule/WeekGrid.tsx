'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef } from 'react';
import { platformName } from '@/components/publish-monitor/labels';
import {
  byDay, chipOf, dayKey, firstHour, HOUR_PX, isToday, minutesOfDay, placeDay, platformsLabel, weekdayShort,
} from '@/lib/publish-schedule/calendar';
import { dayLabel, timeLabel, type ScheduleEntry } from '@/lib/publish-schedule/schedule-view';
import { chipName } from './MonthGrid';
import styles from './schedule-calendar.module.css';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const pad = (n: number) => String(n).padStart(2, '0');

/** A post on the week axis or under the phone's month grid: time and status, the platforms, the caption's start. */
export function EntryCard({ entry, onOpen, className, style, compact = false }: {
  entry: ScheduleEntry; onOpen: (entry: ScheduleEntry) => void; className?: string; style?: React.CSSProperties;
  // Side by side with other posts (a narrow card): the whole time and the platforms only; the rest is in its name and details.
  compact?: boolean;
}) {
  const { status, tone } = chipOf(entry);
  return (
    <button type="button" className={`${styles.card} ${styles.tone} ${className ?? ''}`} data-tone={tone} style={style} title={chipName(entry)}
      aria-label={chipName(entry)} data-compact={compact || undefined} onClick={() => onOpen(entry)}>
      {compact ? <time dateTime={entry.at}>{timeLabel(entry.at)}</time>
        : <span className={styles.cardLine}><time dateTime={entry.at}>{timeLabel(entry.at)}</time> · {status.label}</span>}
      <span className={styles.cardLine}>{platformsLabel(entry, platformName)}</span>
      {!compact && entry.captionPreview && <span className={styles.cardLine}>{entry.captionPreview}</span>}
    </button>
  );
}

/** The week: seven day columns on a 24-hour axis; posts close together share the width. Opens around the first post (or 8:00). */
export function WeekGrid({ days, entries, now, onOpen }: {
  days: Date[]; entries: ScheduleEntry[]; now: Date; onOpen: (entry: ScheduleEntry) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const grouped = byDay(entries);
  const start = firstHour(entries);
  const weekKey = days[0]?.getTime();
  useEffect(() => {
    const element = scroller.current;
    // A little above the hour, so its label is not under the sticky day row.
    if (element) element.scrollTop = Math.max(0, start * HOUR_PX - 12);
    // Only when another week is shown, not each time the list is re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey]);
  return (
    <div ref={scroller} className={styles.week} role="table" aria-label={`${dayLabel(days[0]!)} 起这一周的发布`}>
      <div className={styles.weekTop} role="row">
        <div aria-hidden />
        {days.map(day => (
          <div key={day.toISOString()} role="columnheader" data-today={isToday(day, now) || undefined}>
            <span>{weekdayShort(day)}</span><strong>{day.getDate()}</strong>
          </div>
        ))}
      </div>
      <div className={styles.axis} role="row" style={{ height: 24 * HOUR_PX, ['--hour-px' as string]: `${HOUR_PX}px` }}>
        <div className={styles.hours} aria-hidden>
          {HOURS.slice(1).map(hour => <span key={hour} style={{ top: hour * HOUR_PX }}>{pad(hour)}:00</span>)}
        </div>
        {days.map(day => {
          const today = isToday(day, now);
          const placed = placeDay(grouped.get(dayKey(day)) ?? []);
          return (
            <div key={day.toISOString()} className={styles.column} role="cell" data-today={today || undefined}
              aria-label={`${dayLabel(day)}${today ? '（今天）' : ''}，${placed.length} 条`}>
              {today && <div className={styles.now} style={{ top: (minutesOfDay(now) / 60) * HOUR_PX }} aria-hidden />}
              {placed.map(({ entry, top, column, columns }) => (
                <EntryCard key={entry.id} entry={entry} onOpen={onOpen} compact={columns > 1} style={{
                  top, height: HOUR_PX - 4, left: `calc(${(column / columns) * 100}% + 2px)`, width: `calc(${100 / columns}% - 4px)`,
                }} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
