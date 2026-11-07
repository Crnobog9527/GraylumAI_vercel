/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Redis } from '@upstash/redis';
import { logger } from '../../lib/logger';
import { redisEnvironment } from '../redisEnvironment';
import { dedupeKey, ERROR_SPIKE } from './kinds';
import { defaultNotifyDeps, notifyOwnerWith, type NotifyDeps } from './notify';

/*
 * ALERT-FEISHU 「网站报错」: what the Sentry error mail covered, so that mail can be turned off. The server's Sentry
 * beforeSend calls noteServerError() for every error or fatal event it is about to send; each adds one to a per-minute
 * counter in Redis (shared by every instance) and reads the sum of the last ERROR_SPIKE.minutes minutes. At
 * ERROR_SPIKE.count or more the Owner gets one message, then nothing for ERROR_SPIKE.cooldownSeconds (the dedupe TTL).
 * Browser-side and Edge errors go to Sentry directly and are not counted here.
 * Cost: one Redis round trip per server error, and none at all when alerts are not configured or this instance is
 * inside its cooldown.
 */
export type ErrorCounter = { add(minute: number, windowMinutes: number): Promise<number> };

const DEADLINE_MS = 500;
const counterKey = (minute: number) => `owner-alert-errors:${minute}`;

export function errorWindowKeys(minute: number, windowMinutes: number): string[] {
  return Array.from({ length: windowMinutes }, (_, i) => counterKey(minute - i));
}

let shared: Redis | null = null;

export function redisErrorCounter(): ErrorCounter {
  return {
    async add(minute, windowMinutes) {
      const redis = shared ??= (() => {
        const { url, token } = redisEnvironment(process.env);
        return new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(DEADLINE_MS) });
      })();
      const key = counterKey(minute);
      const [, , values] = await redis.pipeline().incr(key).expire(key, (windowMinutes + 1) * 60)
        .mget<(number | string | null)[]>(...errorWindowKeys(minute, windowMinutes)).exec<[number, number, (number | string | null)[]]>();
      return values.reduce<number>((sum, value) => sum + (Number(value) || 0), 0);
    },
  };
}

export async function noteServerErrorWith(deps: NotifyDeps, counter: ErrorCounter): Promise<boolean> {
  if (!deps.config) return false;
  const now = deps.now();
  if (deps.dedupe.seen(dedupeKey('error_spike', { count: 0, minutes: 0 }, now))) return false;
  const count = await counter.add(Math.floor(now.getTime() / 60_000), ERROR_SPIKE.minutes);
  if (count < ERROR_SPIKE.count) return false;
  return notifyOwnerWith(deps, 'error_spike', { count, minutes: ERROR_SPIKE.minutes });
}

let counter: ErrorCounter | undefined;

/** Never throws, so a Sentry event is never lost to it. */
export async function noteServerError(): Promise<void> {
  try {
    await noteServerErrorWith(defaultNotifyDeps(), counter ??= redisErrorCounter());
  } catch {
    logger.warn('system', 'owner_alert_error_count_failed', { swallowed: true });
  }
}
