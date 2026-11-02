/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Redis } from '@upstash/redis';
import { redisEnvironment } from '../redisEnvironment';

/*
 * CORE-PATH-V2 V2-7a: how a user's stop reaches the running report. Vercel does not tell a function that its client went away
 * unless the function opts into being cancelled, which would also end a report whose page merely closed, and the stop request
 * runs on another instance. So POST /api/turn/stop raises a short-lived flag here after turn_stop has recorded the stop, and the
 * running report looks for it every two seconds while its provider call runs. Redis, never Postgres: a report's database round
 * trips (3.1) are unchanged. Nothing here is worth keeping: a lost flag only means the report runs to its end, as stopped.
 */
export type ReportStopSignal = {
  raise(turnId: number): Promise<unknown>;
  raised(turnId: number): Promise<boolean>;
};
const DEADLINE_MS = 500, TTL_SECONDS = 600;
const key = (turnId: number) => `turn:stop:${turnId}`;

let shared: Redis | null = null;
const redis = () => shared ??= (() => {
  const { url, token } = redisEnvironment(process.env);
  return new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(DEADLINE_MS) });
})();

/** The client is made at first use: a turn that never looks needs no Redis. */
export function redisReportStopSignal(): ReportStopSignal {
  return {
    raise: async turnId => redis().set(key(turnId), 1, { ex: TTL_SECONDS }),
    raised: async turnId => await redis().exists(key(turnId)) === 1,
  };
}
