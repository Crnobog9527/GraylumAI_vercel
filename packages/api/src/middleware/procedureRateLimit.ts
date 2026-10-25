/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RateLimitError } from '../lib/rateLimitError';
import { checkMinuteRateLimit } from '../services/redisRateLimiter';

/**
 * ARCH-FIX A1: every logged-in call is counted per user, once per procedure and once in total,
 * so a batch or a burst of one read cannot reach the database faster than these numbers.
 *
 * Basis (per minute): the fastest normal page polls one read every 2 s (30/min); 120 leaves room
 * for four such views or tabs. Writes are user actions; 60 is one per second. The total, 300, is
 * five calls a second, several times a normal page load plus its polling. The 10-24 burst that
 * stalled staging was about 1,200 calls a minute from one account.
 * The per-call billing limits and pause checks (runtime/rateLimitSettings.ts) are separate and unchanged.
 */
export const PROCEDURE_RATE_LIMITS = { query: 120, mutation: 60, total: 300 } as const;

type Opts<T> = {
  ctx: { user?: { id: string } | null };
  path: string;
  type: 'query' | 'mutation' | 'subscription';
  next: () => Promise<T>;
};

export async function procedureRateLimit<T>({ ctx, path, type, next }: Opts<T>): Promise<T> {
  // No login: the next middleware refuses the call. Nothing to count it against.
  const userId = ctx.user?.id;
  if (!userId) return next();
  const kind = type === 'query' ? 'query' : 'mutation';
  const results = await Promise.all([
    checkMinuteRateLimit(`procedure:${kind}`, `${userId}:${path}`, PROCEDURE_RATE_LIMITS[kind]),
    checkMinuteRateLimit('procedure:user', userId, PROCEDURE_RATE_LIMITS.total),
  ]);
  // Redis down fails closed, like every other limiter in this codebase.
  if (results.some(r => r.reason === 'unavailable')) throw new RateLimitError('unavailable');
  const refused = results.filter(r => !r.success);
  if (refused.length) throw new RateLimitError('rate_limited', Math.max(...refused.map(r => r.retryAfter ?? 60)));
  return next();
}
