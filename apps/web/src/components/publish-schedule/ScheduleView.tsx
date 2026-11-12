'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
// The data review's name table: it also covers the TikHub platforms (抖音, 小红书) a job can list.
import { platformName } from '@/components/publish-monitor/labels';
import {
  changeable, dayLabel, entriesOn, entryStatus, hasOpenEntries, sameLocalDay, scheduleErrorMessage, timeLabel, weekDays,
  weekRange, weekStart, zoneLabel, type ScheduleEntry,
} from '@/lib/publish-schedule/schedule-view';
import { existingPositioning, type ExistingPositioning } from '@/app/(zh-hans)/app/runtime/positioning-required';
import { useProfileBusinesses } from '@/components/opc/profile-archive/profile-archive-api';
import { trpc } from '@/trpc/client';
import { ScheduleChangeDialog } from './ScheduleChangeDialog';

/**
 * PUBLISH-SCHEDULE: "发布排期" — this week's scheduled, sent, failed and cancelled posts in the viewer's local time, with
 * reschedule and cancel until 10 minutes before the time. Everything shown comes from the server (no media links; the
 * caption preview only). Scheduling itself starts from the one-click publish page.
 */
/**
 * An empty week tells a new user (no confirmed positioning yet, by `opc.list`) to finish positioning first; while that
 * list is read or cannot be read, the user is treated as an existing one (the ordinary empty week). "继续定位" opens the
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

const TONE: Record<string, string> = { waiting: 'var(--text-primary)', working: 'var(--text-secondary)',
  done: 'var(--color-success, var(--text-primary))', partial: 'var(--color-warning, var(--text-primary))',
  failed: 'var(--color-error)', cancelled: 'var(--text-secondary)' };

export function ScheduleView() {
  const [offset, setOffset] = useState(0);
  const [change, setChange] = useState<{ entry: ScheduleEntry; mode: 'reschedule' | 'cancel' } | null>(null);
  const start = useMemo(() => weekStart(new Date(), offset), [offset]);
  const range = useMemo(() => weekRange(start), [start]);
  const utils = trpc.useUtils();
  const list = trpc.publishMonitor.schedule.list.useQuery(range, { retry: false,
    refetchInterval: query => (hasOpenEntries((query.state.data ?? []) as ScheduleEntry[], Date.now()) ? 30_000 : false) });
  const entries = (list.data ?? []) as ScheduleEntry[];
  const drafts = trpc.opc.list.useQuery(undefined, { retry: false });
  const empty = !list.isPending && !list.error && entries.length === 0;
  const newUser = empty && isNewUser(drafts);
  const profiles = useProfileBusinesses(newUser);
  const existing = existingPositioning(profiles.businesses, Boolean(profiles.error));
  const days = weekDays(start);
  const today = new Date();
  const refresh = () => { void utils.publishMonitor.schedule.list.invalidate(); };

  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">发布排期</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          看这周什么时候发什么。时间按你的时区显示：{zoneLabel()}。只发布到你授权的账号，发布前由你确认。</p>
      </header>
      <nav aria-label="切换周" className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setOffset(o => o - 1)}>上一周</Button>
        <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(0)}>本周</Button>
        <Button variant="outline" onClick={() => setOffset(o => o + 1)}>下一周</Button>
        <span className="text-sm" aria-live="polite">{dayLabel(days[0]!)} – {dayLabel(days[6]!)}</span>
      </nav>
      {newUser ? <section aria-label="还没有排期" className="space-y-2 rounded-lg border p-4">
        <p className="text-sm">先完成定位、写好第一篇，就能在这里排期。</p>
        <Button asChild><Link href={positioningHref(existing)}>{positioningLabel(existing)}</Link></Button>
      </section> : <div className="space-y-1">
        {empty && <p className="text-sm">这周还没有安排。</p>}
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          要排新的帖子，请在资料库里打开一条内容，选"一键发布"后选择发布时间。已排期的帖子不会跟着内容的修改变化；要改内容，请取消后重新排期。
          <Link className="ml-1 underline" href="/app/library">去资料库</Link></p>
      </div>}
      {list.isPending ? <PageSkeleton compact rows={4} label="发布排期读取中" />
        : list.error ? <div className="space-y-2">
          <p role="alert" className="text-sm">{scheduleErrorMessage(list.error.message, list.error.data?.code)}</p>
          <Button variant="outline" onClick={refresh}>重试</Button></div>
          : <ol className="space-y-3" aria-label="本周的发布">
            {days.map(day => {
              const items = entriesOn(entries, day);
              return (
                <li key={day.toISOString()} className="rounded-lg border p-3">
                  <h2 className="text-sm font-medium">{dayLabel(day)}{sameLocalDay(day, today) ? '（今天）' : ''}</h2>
                  {items.length === 0 ? <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>没有安排</p>
                    : <ul className="mt-2 space-y-2">{items.map(entry =>
                      <EntryRow key={entry.id} entry={entry} onChange={mode => setChange({ entry, mode })} />)}</ul>}
                </li>
              );
            })}
          </ol>}
      {change && <ScheduleChangeDialog entry={change.entry} mode={change.mode} onClose={() => setChange(null)}
        onChanged={refresh} />}
    </main>
  );
}

function EntryRow({ entry, onChange }: { entry: ScheduleEntry; onChange: (mode: 'reschedule' | 'cancel') => void }) {
  const status = entryStatus(entry);
  const open = changeable(entry, Date.now());
  return (
    <li className="space-y-1 rounded-md bg-[var(--surface-secondary,transparent)] p-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium tabular-nums">{timeLabel(entry.at)}</span>
        <span className="font-medium" style={{ color: TONE[status.tone] }}>{status.label}</span>
        <span className="min-w-0 flex-1 truncate">{entry.captionPreview || '（没有文字）'}</span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="平台">
        {entry.targets.map(target => <li key={target.connectionId}>
          {platformName(target.platform)}
          {target.status === 'published' && target.url ? <a className="ml-1 underline" href={target.url} target="_blank"
            rel="noopener noreferrer">查看帖子</a> : target.status === 'failed' ? ' · 失败' : ''}
        </li>)}
      </ul>
      <p style={{ color: 'var(--text-secondary)' }}>{status.detail}</p>
      {open && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onChange('reschedule')}>改期</Button>
        <Button size="sm" variant="outline" onClick={() => onChange('cancel')}>取消排期</Button>
      </div>}
      {entry.state === 'scheduled' && !open && !entry.cancelReason
        && <p style={{ color: 'var(--text-secondary)' }}>离发布不到 10 分钟，已经不能改期或取消。</p>}
    </li>
  );
}
