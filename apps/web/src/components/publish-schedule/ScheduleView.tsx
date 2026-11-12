'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  LEGEND, shiftAnchor, showsToday, startOfDay, viewDays, viewRange, viewTitle, type CalendarView,
} from '@/lib/publish-schedule/calendar';
import { hasOpenEntries, scheduleErrorMessage, zoneLabel, type ScheduleEntry } from '@/lib/publish-schedule/schedule-view';
import { existingPositioning, type ExistingPositioning } from '@/app/(zh-hans)/app/runtime/positioning-required';
import { useProfileBusinesses } from '@/components/opc/profile-archive/profile-archive-api';
import { trpc } from '@/trpc/client';
import { MiniMonth, MonthGrid } from './MonthGrid';
import { ScheduleChangeDialog } from './ScheduleChangeDialog';
import { ScheduleDetailDialog } from './ScheduleDetailDialog';
import { AgendaList, WeekGrid } from './WeekGrid';
import styles from './schedule-calendar.module.css';

/**
 * PUBLISH-SCHEDULE: "发布排期" — a calendar of the user's scheduled, sent, failed and cancelled posts in the viewer's local
 * time (Owner 2026-11-12: like a desktop calendar; month first, a week time axis, a small month on the side). A post opens
 * its details, with reschedule and cancel until 10 minutes before the time. Everything shown comes from the server (no media
 * links; the caption preview only). Scheduling itself starts from the one-click publish page.
 */
/**
 * An empty page tells a new user (no confirmed positioning yet, by `opc.list`) to finish positioning first; while that
 * list is read or cannot be read, the user is treated as an existing one (the ordinary empty page). "继续定位" opens the
 * same positioning as the guide card's 继续我的定位 (`existingPositioning`, #1890): the newest profile not archived.
 */
export function isNewUser(drafts: { isPending: boolean; error: unknown; data?: unknown }): boolean {
  if (drafts.isPending || drafts.error) return false;
  const list = (drafts.data as { drafts?: Array<{ state?: string; currentVersion?: number }> } | undefined)?.drafts;
  // Confirmed as the positioning page counts it: published, or a revision of one that was published before.
  return Array.isArray(list) && !list.some(draft => draft.state === 'published' || (draft.currentVersion ?? 0) > 0);
}
export function positioningHref(existing: ExistingPositioning): string {
  return existing.state === 'draft' ? `/app/positioning/${existing.draftId}` : '/app/positioning';
}
/** 继续定位 when a positioning is under way; 开始定位 when there is none yet (or while that is still being read). */
export const positioningLabel = (existing: ExistingPositioning) => existing.state === 'draft' ? '继续定位' : '开始定位';

// Phones get a list of days instead of seven narrow columns. The server render (and the first client render) is the grid.
const PHONE = '(max-width: 640px)';
function usePhone(): boolean {
  return useSyncExternalStore(change => {
    const query = window.matchMedia(PHONE);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, () => window.matchMedia(PHONE).matches, () => false);
}

/** The current minute, for today's mark and the week axis's now line. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  return now;
}

export function ScheduleView() {
  const now = useNow();
  const phone = usePhone();
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [opened, setOpened] = useState<ScheduleEntry | null>(null);
  const [change, setChange] = useState<{ entry: ScheduleEntry; mode: 'reschedule' | 'cancel' } | null>(null);
  const range = useMemo(() => viewRange(view, anchor), [view, anchor]);
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const utils = trpc.useUtils();
  const list = trpc.publishMonitor.schedule.list.useQuery(range, { retry: false,
    refetchInterval: query => (hasOpenEntries((query.state.data ?? []) as ScheduleEntry[], Date.now()) ? 30_000 : false) });
  const entries = (list.data ?? []) as ScheduleEntry[];
  const drafts = trpc.opc.list.useQuery(undefined, { retry: false });
  const empty = !list.isPending && !list.error && entries.length === 0;
  const newUser = empty && isNewUser(drafts);
  const profiles = useProfileBusinesses(newUser);
  const existing = existingPositioning(profiles.businesses, Boolean(profiles.error));
  const refresh = () => { void utils.publishMonitor.schedule.list.invalidate(); };
  const step = (by: -1 | 1) => setAnchor(current => shiftAnchor(view, current, by));
  const unit = view === 'month' ? '月' : '周';
  // The opened post as last read: a re-read while the details are open (a result came in) updates them.
  const shown = opened ? entries.find(entry => entry.id === opened.id) ?? opened : null;
  const openWeek = (day: Date) => { setView('week'); setAnchor(startOfDay(day)); };

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1>发布排期</h1>
        <span className={styles.zone}>时间按你的时区显示：{zoneLabel()}</span>
      </header>
      <nav className={styles.toolbar} aria-label="切换日期">
        <button type="button" className={styles.toolButton} disabled={showsToday(view, anchor, now)}
          onClick={() => setAnchor(startOfDay(new Date()))}>今天</button>
        <button type="button" className={`${styles.toolButton} ${styles.iconButton}`} aria-label={`上一${unit}`}
          onClick={() => step(-1)}>‹</button>
        <button type="button" className={`${styles.toolButton} ${styles.iconButton}`} aria-label={`下一${unit}`}
          onClick={() => step(1)}>›</button>
        <h2 className={styles.title} aria-live="polite">{viewTitle(view, anchor)}</h2>
        <div className={styles.switch} role="group" aria-label="视图">
          {(['month', 'week'] as const).map(option => <button key={option} type="button" aria-pressed={view === option}
            onClick={() => setView(option)}>{option === 'month' ? '月' : '周'}</button>)}
        </div>
      </nav>
      <div className={styles.body}>
        <aside className={styles.side} aria-label="日历工具">
          <MiniMonth shown={days} entries={entries} now={now} onPick={day => setAnchor(startOfDay(day))} />
          <section aria-label="颜色说明">
            <h3 className={styles.sideTitle}>状态</h3>
            <ul className={styles.legend}>
              {LEGEND.map(item => <li key={item.tone}>
                <span className={`${styles.swatch} ${styles.tone}`} data-tone={item.tone} aria-hidden />{item.label}</li>)}
            </ul>
          </section>
        </aside>
        <div className={styles.main}>
          {newUser ? <section aria-label="还没有排期" className={styles.notice}>
            <p>先完成定位、写好第一篇，就能在这里排期。</p>
            <Button asChild><Link href={positioningHref(existing)}>{positioningLabel(existing)}</Link></Button>
          </section> : <div className={styles.notice}>
            {empty && <p>{view === 'month' ? '这个月还没有安排。' : '这周还没有安排。'}</p>}
            <p className={styles.note}>
              要排新的帖子，请在资料库里打开一条内容，选"一键发布"后选择发布时间。已排期的帖子不会跟着内容的修改变化；要改内容，请取消后重新排期。
              <Link className="ml-1" href="/app/library">去资料库</Link></p>
          </div>}
          {list.isPending ? <div className={styles.state}><PageSkeleton compact rows={4} label="发布排期读取中" /></div>
            : list.error ? <div className={styles.state}>
              <p role="alert" className="mb-2">{scheduleErrorMessage(list.error.message, list.error.data?.code)}</p>
              <Button variant="outline" onClick={refresh}>重试</Button></div>
              : phone ? <AgendaList days={days} entries={entries} now={now} onOpen={setOpened} />
                : view === 'month' ? <MonthGrid anchor={anchor} entries={entries} now={now} onOpen={setOpened} onOpenDay={openWeek} />
                  : <WeekGrid days={days} entries={entries} now={now} onOpen={setOpened} />}
        </div>
      </div>
      {shown && <ScheduleDetailDialog entry={shown} onClose={() => setOpened(null)}
        onChange={mode => { setChange({ entry: shown, mode }); setOpened(null); }} />}
      {change && <ScheduleChangeDialog entry={change.entry} mode={change.mode} onClose={() => setChange(null)}
        onChanged={refresh} />}
    </main>
  );
}
