'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import {
  byDay, chipOf, dayKey, isToday, monthTitle, monthWeeks, WEEK_HEAD,
} from '@/lib/publish-schedule/calendar';
import { dayLabel, type ScheduleEntry } from '@/lib/publish-schedule/schedule-view';
import { EntryCard } from './WeekGrid';
import styles from './schedule-calendar.module.css';

/** A day shows at most this many status dots; more posts show a "+". */
const DOTS = 3;

/**
 * Phones (Owner 2026-11-12: "做成网格，完整地展示 1 号到 30 号……点击每个节点（日期）后……在下方展示该节点内的排期"):
 * the whole month as a grid, one coloured dot per post; the picked day's posts are listed below as cards that open the post.
 */
export function PhoneMonth({ anchor, entries, now, selected, onSelect, onOpen, footer }: {
  anchor: Date; entries: ScheduleEntry[]; now: Date; selected: Date; onSelect: (day: Date) => void;
  onOpen: (entry: ScheduleEntry) => void; footer?: ReactNode;
}) {
  const days = byDay(entries);
  const picked = days.get(dayKey(selected)) ?? [];
  return (
    <div className={styles.phone}>
      <div className={styles.phoneGrid} role="group" aria-label={`${monthTitle(anchor)}，选一天看它的排期`}>
        {WEEK_HEAD.map(name => <span key={name} className={styles.phoneHead} aria-hidden>{name.slice(1)}</span>)}
        {monthWeeks(anchor).flat().map(day => {
          // Only the month's own days: the grid reads 1 to 30 (or 31), the other months' days stay blank.
          if (day.getMonth() !== anchor.getMonth()) return <span key={day.toISOString()} aria-hidden />;
          const items = days.get(dayKey(day)) ?? [];
          const today = isToday(day, now);
          const on = dayKey(day) === dayKey(selected);
          return (
            <button key={day.toISOString()} type="button" className={styles.phoneDay} aria-pressed={on}
              data-today={today || undefined} onClick={() => onSelect(day)}
              aria-label={`${dayLabel(day)}${today ? '（今天）' : ''}，${items.length ? `${items.length} 条` : '没有安排'}`}>
              <span className={styles.phoneNumber}>{day.getDate()}</span>
              <span className={styles.dots} aria-hidden>
                {items.slice(0, DOTS).map(entry => <i key={entry.id} className={`${styles.dot} ${styles.tone}`}
                  data-tone={chipOf(entry).tone} />)}
                {items.length > DOTS && <b>+</b>}
              </span>
            </button>
          );
        })}
      </div>
      <section className={styles.phoneDayList} aria-label={`${dayLabel(selected)}的排期`}>
        <h2>{dayLabel(selected)}{isToday(selected, now) && <span>今天</span>}</h2>
        {picked.length === 0 ? <p className={styles.note}>这天没有安排。</p>
          : <ul className={styles.phoneCards}>
            {picked.map(entry => <li key={entry.id}><EntryCard entry={entry} onOpen={onOpen} className={styles.phoneCard} /></li>)}
          </ul>}
      </section>
      {footer}
    </div>
  );
}
