'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
// The data review's name table: it also covers the TikHub platforms (抖音, 小红书) a job can list (#1904).
import { platformName } from '@/components/publish-monitor/labels';
import { chipOf } from '@/lib/publish-schedule/calendar';
import { changeable, dateTimeLabel, weekdayOf, zoneLabel, type ScheduleEntry } from '@/lib/publish-schedule/schedule-view';
import styles from './schedule-calendar.module.css';

/**
 * PUBLISH-SCHEDULE: one post opened from the calendar. Everything the old week list showed (status and its credits sentence,
 * platforms with their post links or failure, the caption's start), and 改期 / 取消排期 until 10 minutes before the time.
 */
export function ScheduleDetailDialog({ entry, onClose, onChange }: {
  entry: ScheduleEntry; onClose: () => void; onChange: (mode: 'reschedule' | 'cancel') => void;
}) {
  const { status, tone } = chipOf(entry);
  const open = changeable(entry, Date.now());
  const locked = entry.state === 'scheduled' && !open && !entry.cancelReason;
  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent tone="light" aria-describedby="schedule-detail-status">
        <DialogHeader>
          <DialogTitle>{dateTimeLabel(entry.at)} {weekdayOf(entry.at)}</DialogTitle>
          <DialogDescription id="schedule-detail-status" className="flex flex-wrap items-center gap-2">
            <span className={`${styles.detailStatus} ${styles.tone}`} data-tone={tone}>{status.label}</span>
            <span>{status.detail}</span>
          </DialogDescription>
        </DialogHeader>
        <div className={styles.detail}>
          <dl className={styles.detailRows}>
            <dt>平台</dt>
            <dd><ul className={styles.platforms} aria-label="平台">
              {entry.targets.length === 0 && <li className={styles.muted}>没有平台</li>}
              {entry.targets.map(target => <li key={target.connectionId}>
                {platformName(target.platform)}
                {/* Each platform's outcome in words; a sent post also links to itself when the platform gave its address. */}
                {target.status === 'published' ? ' · 已发布' : target.status === 'failed' ? ' · 失败' : ''}
                {target.status === 'published' && target.url && <a className="ml-1" href={target.url} target="_blank"
                  rel="noopener noreferrer">查看帖子</a>}
              </li>)}
            </ul></dd>
            <dt>文案</dt>
            <dd>{entry.captionPreview || <span className={styles.muted}>（没有文字）</span>}</dd>
            <dt>时区</dt>
            <dd>{zoneLabel()}</dd>
          </dl>
          {locked && <p className={styles.muted}>离发布不到 10 分钟，已经不能改期或取消。</p>}
          <p className={styles.muted}>已排期的帖子不会跟着内容的修改变化；要改内容，请取消后重新排期。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {open && <>
            <Button variant="outline" onClick={() => onChange('cancel')}>取消排期</Button>
            <Button onClick={() => onChange('reschedule')}>改期</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
