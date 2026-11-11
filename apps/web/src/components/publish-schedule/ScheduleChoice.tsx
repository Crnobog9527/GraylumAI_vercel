'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { MAX_LEAD_MS, MIN_LEAD_MS, toLocalInput, zoneLabel } from '@/lib/publish-schedule/schedule-view';

/**
 * PUBLISH-SCHEDULE: "立即发布 / 定时发布" in the one-click publish form. The time is picked in the viewer's local time
 * (15 minutes to 30 days ahead, the range the server checks); the form sends it as a UTC instant.
 */
export function ScheduleChoice({ mode, value, problem, disabled, onModeChange, onValueChange }: {
  mode: 'now' | 'later'; value: string; problem: string | null; disabled: boolean;
  onModeChange: (mode: 'now' | 'later') => void; onValueChange: (value: string) => void;
}) {
  const now = Date.now();
  return (
    <fieldset className="space-y-2 text-sm" disabled={disabled}>
      <legend className="sr-only">什么时候发</legend>
      <label className="flex items-center gap-2">
        <input type="radio" name="publish-when" checked={mode === 'now'} onChange={() => onModeChange('now')} />立即发布
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name="publish-when" checked={mode === 'later'} onChange={() => onModeChange('later')} />定时发布
      </label>
      {mode === 'later' && (
        <div className="space-y-1 pl-6">
          <input type="datetime-local" aria-label="发布时间" className="block w-full max-w-xs rounded-md border px-3 py-2"
            value={value} min={toLocalInput(now + MIN_LEAD_MS)} max={toLocalInput(now + MAX_LEAD_MS)}
            onChange={event => onValueChange(event.target.value)} />
          <p style={{ color: 'var(--text-secondary)' }}>
            按你的时区：{zoneLabel()}。最早 15 分钟后、最远 30 天内；发布前 10 分钟之前可以在“发布排期”里改期或取消。</p>
          {problem && <p role="alert" className="text-[var(--color-error)]">{problem}</p>}
        </div>
      )}
    </fieldset>
  );
}

/** The default time offered: one hour from now, on the next whole quarter hour. */
export function defaultLaterValue(now = Date.now()): string {
  const quarter = 15 * 60_000;
  return toLocalInput(Math.ceil((now + 3600_000) / quarter) * quarter);
}
