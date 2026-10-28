/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { redisEnvironment } from '../redisEnvironment';

/*
 * CORE-PATH-V2 3.3.2 item 10: at most `limit` calls in flight per model (or supplier) across every instance. Each call holds one
 * member of a Redis sorted set scored by its own expiry, so a slot left by an instance that died (or whose release failed) runs
 * out on its own after `ttlSeconds`, however much traffic keeps arriving: every take first drops the members past their expiry.
 * Above the limit the call waits with backoff and is refused after `waitMs`. Like the request rate limiter, it fails closed: an
 * unreachable store refuses the call, it never lets it through unbounded. Nothing in it is worth keeping: losing it only resets
 * the in-flight counts.
 */
export type CounterStore = {
  /** Drop members expired by `nowMs`, add `member` expiring at `expiresAtMs`, and return how many members are live. */
  take(key: string, member: string, nowMs: number, expiresAtMs: number): Promise<number>;
  drop(key: string, member: string): Promise<unknown>;
};
export class ProviderBusyError extends Error {
  constructor(readonly code: 'TURN_PROVIDER_BUSY' | 'TURN_PROVIDER_LIMIT_UNAVAILABLE') { super(code); }
}

const DEADLINE_MS = 500;
function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TURN_COUNTER_TIMEOUT')), DEADLINE_MS);
  })]).finally(() => clearTimeout(timer));
}

let shared: Redis | null = null;
export function redisCounterStore(): CounterStore {
  shared ??= (() => {
    const { url, token } = redisEnvironment(process.env);
    return new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(DEADLINE_MS) });
  })();
  const redis = shared;
  return {
    async take(key, member, nowMs, expiresAtMs) {
      const [, , count] = await redis.multi().zremrangebyscore(key, 0, nowMs).zadd(key, { score: expiresAtMs, member })
        .zcard(key).pexpireat(key, expiresAtMs).exec<[number, number, number, number]>();
      return count;
    },
    drop: (key, member) => redis.zrem(key, member),
  };
}

export type Release = () => Promise<void>;
export type LimiterOptions = { limit: number; waitMs?: number; ttlSeconds?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

/** Take one slot of `key`, waiting with backoff (100 ms doubling to 1.6 s) up to `waitMs`. The release is idempotent. */
export async function acquireSlot(store: CounterStore, key: string, options: LimiterOptions): Promise<Release> {
  const limit = options.limit, waitMs = options.waitMs ?? 10_000, ttl = options.ttlSeconds ?? 600;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), now = options.now ?? Date.now;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('TURN_PROVIDER_LIMIT_INVALID');
  const counter = `turn:inflight:${key}`, start = now();
  for (let delay = 100; ; delay = Math.min(delay * 2, 1600)) {
    const member = randomUUID(), at = now();
    let count: number;
    try { count = await deadline(store.take(counter, member, at, at + ttl * 1000)); }
    catch { throw new ProviderBusyError('TURN_PROVIDER_LIMIT_UNAVAILABLE'); }
    if (count <= limit) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        // A failed release only leaves the slot to its own expiry; it never fails the turn.
        try { await deadline(store.drop(counter, member)); } catch { /* it expires */ }
      };
    }
    try { await deadline(store.drop(counter, member)); } catch { /* it expires */ }
    if (now() - start + delay > waitMs) throw new ProviderBusyError('TURN_PROVIDER_BUSY');
    await sleep(delay);
  }
}
