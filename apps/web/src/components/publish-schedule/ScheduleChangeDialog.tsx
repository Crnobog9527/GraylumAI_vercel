'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  dateTimeLabel, fromLocalInput, MAX_LEAD_MS, MIN_LEAD_MS, scheduleErrorMessage, timeProblem, toLocalInput, zoneLabel,
  type ScheduleEntry,
} from '@/lib/publish-schedule/schedule-view';
import { trpc } from '@/trpc/client';

/**
 * PUBLISH-SCHEDULE: move or cancel one scheduled post. The server checks the time range, the 10-minute lock and that
 * nobody changed the post meanwhile (the expected time is sent along); this dialog only shows the answer.
 */
export function ScheduleChangeDialog({ entry, mode, onClose, onChanged }: {
  entry: ScheduleEntry; mode: 'reschedule' | 'cancel'; onClose: () => void; onChanged: () => void;
}) {
  const now = Date.now();
  const [value, setValue] = useState(() => toLocalInput(Date.parse(entry.scheduledAt ?? entry.at)));
  const reschedule = trpc.publishMonitor.schedule.reschedule.useMutation({ onSuccess: () => { onChanged(); onClose(); },
    onError: () => onChanged() });
  const cancel = trpc.publishMonitor.schedule.cancel.useMutation({ onSuccess: () => { onChanged(); onClose(); },
    onError: () => onChanged() });
  const pending = reschedule.isPending || cancel.isPending;
  const error = reschedule.error ?? cancel.error;
  const newAt = fromLocalInput(value);
  const problem = mode === 'reschedule' ? timeProblem(newAt, now) : null;
  const expectedAt = entry.scheduledAt ?? entry.at;
  return (
    <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
      <DialogContent tone="light" aria-describedby="schedule-change-note">
        <DialogHeader>
          <DialogTitle>{mode === 'reschedule' ? '改期' : '取消这条排期'}</DialogTitle>
          <DialogDescription id="schedule-change-note">
            {mode === 'reschedule'
              ? `原定 ${dateTimeLabel(expectedAt)}（${zoneLabel()}）。新时间最早 15 分钟后、最远 30 天内；发布前 10 分钟起不能再改。`
              : `原定 ${dateTimeLabel(expectedAt)} 发出。取消后帖子不会发出，冻结的 ${entry.holdCredits ?? 0} 积分全部退回。`}
          </DialogDescription>
        </DialogHeader>
        {mode === 'reschedule' && (
          <label className="space-y-1 text-sm">
            <span>新的发布时间</span>
            <input type="datetime-local" aria-label="新的发布时间" className="block w-full rounded-md border px-3 py-2"
              value={value} min={toLocalInput(now + MIN_LEAD_MS)} max={toLocalInput(now + MAX_LEAD_MS)}
              onChange={event => setValue(event.target.value)} />
            {problem && <span role="alert" className="block text-[var(--color-error)]">{problem}</span>}
          </label>
        )}
        {error && <p role="alert" className="text-sm text-[var(--color-error)]">
          {scheduleErrorMessage(error.message, error.data?.code)}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>{mode === 'cancel' ? '不取消' : '关闭'}</Button>
          {mode === 'reschedule'
            ? <Button disabled={pending || !!problem || !newAt}
              onClick={() => newAt && reschedule.mutate({ jobId: entry.id, expectedAt, newAt })}>
              {reschedule.isPending ? '正在改期……' : '确认改期'}</Button>
            : <Button variant="destructive" disabled={pending}
              onClick={() => cancel.mutate({ jobId: entry.id, expectedAt })}>{cancel.isPending ? '正在取消……' : '确认取消'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
