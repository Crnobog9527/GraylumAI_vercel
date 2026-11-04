/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../lib/logger';

/*
 * Where a turn's time goes before and after its model calls (controller 2026-11-05). POST /api/turn starts one timer per request;
 * the stages mark themselves; one log line `turn_stage_timing` is written when the stream ends. The line holds only the kind, the
 * turn number, the fixed outcome code and millisecond numbers: no text, no user or session id. Each stage value is the time since
 * the previous mark, so the values add up to totalMs (a stage that did not run is absent). Nothing here changes what a turn does.
 */
type Timer = { kind: string; started: number; last: number; stages: Record<string, number>; turnId?: number; reported: boolean };
const timers = new AsyncLocalStorage<Timer>();
const clock = () => performance.now();

/** Runs `work` (and every async continuation, a streamed reply included) under a new timer. */
export function withStageTimer<T>(kind: string, work: () => T): T {
  const now = clock();
  return timers.run({ kind, started: now, last: now, stages: {}, reported: false }, work);
}

/** Closes the stage that just ran; the same name twice adds up. Outside a timer it does nothing. */
export function markStage(name: string): void {
  const timer = timers.getStore();
  if (!timer) return;
  const now = clock();
  timer.stages[name] = (timer.stages[name] ?? 0) + (now - timer.last);
  timer.last = now;
}

/** The turn the stages belong to, known once turn_open has answered. */
export function noteStageTurn(turnId: number): void {
  const timer = timers.getStore();
  if (timer) timer.turnId = turnId;
}

/** Writes the line once per timer; `outcome` is `result` or a fixed error code. */
export function reportStages(outcome: string): void {
  const timer = timers.getStore();
  if (!timer || timer.reported) return;
  timer.reported = true;
  markStage('end');
  const stages = Object.fromEntries(Object.entries(timer.stages).map(([name, ms]) => [`${name}Ms`, Math.round(ms)]));
  logger.info('api', 'turn_stage_timing', { kind: timer.kind, outcome, ...(timer.turnId === undefined ? {} : { turnId: timer.turnId }),
    totalMs: Math.round(clock() - timer.started), uptimeS: Math.round(process.uptime()), ...stages });
}
