/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Redis } from '@upstash/redis';
import { redisEnvironment } from '../redisEnvironment';

/*
 * ALERT-FEISHU: one message per fact. Stripe redelivers a failed event for up to three days and every attempt can land on
 * another instance, so the mark is shared and atomic: `SET key NX EX ttl` in the Upstash Redis every environment already
 * requires (no table, no migration). The same mark is the cooldown of a rate alert: its key names the alert, its TTL is
 * the cooldown. A per-instance memory in front saves the Redis call for repeats. If Redis cannot be reached the alert
 * still goes out: a duplicate beats a missed refund (the memory still stops repeats from this instance).
 * Same idea as Shotviva T72 (core/alerts/dedupe.ts), with Redis in place of its R2 marker objects.
 */
export const MARK_PREFIX = 'owner-alert:';
const MEMORY_LIMIT = 500;
/** An instance that lost the Redis race remembers that only briefly: if the owner's send fails and frees the key, a retry that lands
 * here must be able to compete again (a full-TTL memo here would turn one failed send into a missed refund alert). */
export const LOST_MEMO_SECONDS = 60;
/** Each Redis call (claim or release) gives up after this; a claim that times out still sends. */
export const MARK_DEADLINE_MS = 500;

export type MarkStore = {
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  remove(key: string): Promise<void>;
};

export type Dedupe = {
  /** true: this caller owns the key and should send. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Claimed by this instance and still inside its TTL (no network). */
  seen(key: string): boolean;
  /** The send failed: free the key so a redelivery can try again. */
  release(key: string): Promise<void>;
};

export function createDedupe(store: () => MarkStore | null, now: () => number = Date.now): Dedupe {
  const memory = new Map<string, number>();
  const live = (key: string) => {
    const until = memory.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    memory.delete(key);
    return false;
  };
  const remember = (key: string, ttlSeconds: number) => {
    memory.set(key, now() + ttlSeconds * 1000);
    // Maps iterate in insertion order: drop the oldest.
    if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  };
  return {
    seen: live,
    async claim(key, ttlSeconds) {
      if (live(key)) return false;
      remember(key, ttlSeconds);
      let marks: MarkStore | null = null;
      try {
        marks = store();
        if (!marks) return true;
        const won = await marks.setIfAbsent(`${MARK_PREFIX}${key}`, new Date(now()).toISOString(), ttlSeconds);
        if (!won) remember(key, Math.min(ttlSeconds, LOST_MEMO_SECONDS));
        return won;
      } catch {
        return true;
      }
    },
    async release(key) {
      memory.delete(key);
      try {
        await store()?.remove(`${MARK_PREFIX}${key}`);
      } catch { /* the mark expires on its own */ }
    },
  };
}

let shared: Redis | null = null;

/** The client is made at first use, so a deployment that never alerts never opens it. */
export function redisMarkStore(): MarkStore {
  const redis = shared ??= (() => {
    const { url, token } = redisEnvironment(process.env);
    return new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(MARK_DEADLINE_MS) });
  })();
  return {
    setIfAbsent: async (key, value, ttlSeconds) => await redis.set(key, value, { nx: true, ex: ttlSeconds }) === 'OK',
    remove: async key => { await redis.del(key); },
  };
}
