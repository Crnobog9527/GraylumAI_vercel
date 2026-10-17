/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { redisEnvironment } from '../../redisEnvironment';
import type { ClientDeps, Limiter } from './client';

// The provider allows 40 requests/minute and 5/second per key (measured 2026-10-13), shared by every
// user, page, cron batch and publish. Stay under both with headroom; fail closed when Redis is down.
export const SHARED_PER_MINUTE = 36;
export const SHARED_PER_SECOND = 4;
const DEADLINE_MS = 500;
const API_KEY = /^pfm_(live|test)_[A-Za-z0-9]{8,128}$/;

export class PostForMeNotConfigured extends Error {
  constructor() { super('POSTFORME_NOT_CONFIGURED'); }
}

/** Reads the key at call time from the server environment; it is never logged, returned or persisted. */
export function postForMeApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.POSTFORME_API_KEY?.trim();
  if (!key || !API_KEY.test(key)) throw new PostForMeNotConfigured();
  return key;
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('POSTFORME_LIMITER_TIMEOUT')), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}

let shared: { minute: Ratelimit; second: Ratelimit } | null = null;

/** One global bucket pair for the whole site. Unavailable Redis means no call (retry later), never a free pass. */
export function sharedLimiter(env: NodeJS.ProcessEnv = process.env): Limiter {
  return {
    async acquire() {
      try {
        if (!shared) {
          const { url, token } = redisEnvironment(env);
          // Each Redis request is cancelled at the same deadline, so a stalled Upstash call cannot linger and later
          // take a token for a provider call that was never admitted.
          const redis = new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(DEADLINE_MS) });
          const common = { redis, analytics: false, timeout: 0 } as const;
          shared = {
            minute: new Ratelimit({ ...common, limiter: Ratelimit.slidingWindow(SHARED_PER_MINUTE, '1 m'),
              prefix: 'graylum:ratelimit:postforme:minute:' }),
            second: new Ratelimit({ ...common, limiter: Ratelimit.fixedWindow(SHARED_PER_SECOND, '1 s'),
              prefix: 'graylum:ratelimit:postforme:second:' }),
          };
        }
        for (const [bucket, fallback] of [[shared.second, 1], [shared.minute, 60]] as const) {
          const result = await deadline(bucket.limit('global'));
          if (result.reason === 'timeout') return { ok: false, retryAfterSeconds: 5 };
          if (!result.success) {
            return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) || fallback };
          }
        }
        return { ok: true };
      } catch {
        return { ok: false, retryAfterSeconds: 5 };
      }
    },
  };
}

// Per user, upload slots are counted one by one (a post has up to 10 files): at most 10 provider upload calls per user
// in 5 minutes, however the requests are split or run in parallel, so one user cannot tie up the shared budget.
export const UPLOAD_SLOTS_PER_USER = 10;
let uploads: Ratelimit | null = null;

/** Takes `count` upload slots for one user at once; Redis unavailable means no slots (fail closed). */
export async function takeUploadSlots(userId: string, count: number,
  env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  try {
    if (!uploads) {
      const { url, token } = redisEnvironment(env);
      const redis = new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(DEADLINE_MS) });
      uploads = new Ratelimit({ redis, analytics: false, timeout: 0, prefix: 'graylum:ratelimit:postforme:uploads:',
        limiter: Ratelimit.slidingWindow(UPLOAD_SLOTS_PER_USER, '5 m') });
    }
    const result = await deadline(uploads.limit(userId, { rate: count }));
    if (result.reason === 'timeout') return { ok: false, retryAfterSeconds: 5 };
    return result.success ? { ok: true }
      : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) };
  } catch {
    return { ok: false, retryAfterSeconds: 5 };
  }
}

export function postForMeDeps(env: NodeJS.ProcessEnv = process.env): ClientDeps {
  return { apiKey: postForMeApiKey(env), limiter: sharedLimiter(env) };
}
