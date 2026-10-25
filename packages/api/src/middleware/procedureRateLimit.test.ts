/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { RateLimitResult } from '../services/redisRateLimiter';

vi.unmock('./procedureRateLimit');
const counts = new Map<string, number>();
let unavailable = false;
// A per-minute counter stand-in: every key counts on its own, like the Redis sliding windows.
const check = vi.fn(async (prefix: string, identifier: string, limit: number): Promise<RateLimitResult> => {
  if (unavailable) return { success: false, limit: 0, remaining: 0, reset: 0, retryAfter: 60, reason: 'unavailable' };
  const key = `${prefix}|${identifier}`;
  const used = (counts.get(key) ?? 0) + 1;
  counts.set(key, used);
  return used <= limit ? { success: true, limit, remaining: limit - used, reset: 0 }
    : { success: false, limit, remaining: 0, reset: 0, retryAfter: 42, reason: 'rate_limited' };
});
vi.mock('../services/redisRateLimiter', () => ({ checkMinuteRateLimit: check }));

const { procedureRateLimit, PROCEDURE_RATE_LIMITS } = await import('./procedureRateLimit');
const { protectedProcedure, router } = await import('../trpc');

const call = (user: string | null, path: string, type: 'query' | 'mutation' = 'query') =>
  procedureRateLimit({ ctx: { user: user ? { id: user } : null }, path, type, next: async () => 'ok' });
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: TRPCError) => e.code);

beforeEach(() => { counts.clear(); check.mockClear(); unavailable = false; });

describe('procedureRateLimit', () => {
  it('counts each call per user and procedure, and per user in total, with the right keys and limits', async () => {
    expect(await call('u1', 'library.list')).toBe('ok');
    expect(await call('u1', 'library.remove', 'mutation')).toBe('ok');
    expect(check.mock.calls).toEqual([
      ['procedure:query', 'u1:library.list', 120], ['procedure:user', 'u1', 300],
      ['procedure:mutation', 'u1:library.remove', 60], ['procedure:user', 'u1', 300],
    ]);
  });

  it('lets a call without login through untouched; the login check refuses it', async () => {
    expect(await call(null, 'library.list')).toBe('ok');
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses one procedure past its limit without affecting other procedures or other users', async () => {
    for (let i = 0; i < PROCEDURE_RATE_LIMITS.query; i++) await call('u1', 'library.search');
    const refused = await call('u1', 'library.search').catch((e: TRPCError & { retryAfter: number }) => e);
    expect(refused).toMatchObject({ code: 'TOO_MANY_REQUESTS', retryAfter: 42 });
    expect(await call('u1', 'library.list')).toBe('ok');
    expect(await call('u2', 'library.search')).toBe('ok');
  });

  it('refuses writes past their own, lower limit', async () => {
    for (let i = 0; i < PROCEDURE_RATE_LIMITS.mutation; i++) await call('u1', 'library.purpose', 'mutation');
    expect(await code(call('u1', 'library.purpose', 'mutation'))).toBe('TOO_MANY_REQUESTS');
  });

  it('refuses a user spreading calls across procedures once the total is reached', async () => {
    for (let i = 0; i < PROCEDURE_RATE_LIMITS.total; i++) await call('u1', `p${i}`);
    expect(await code(call('u1', 'fresh.procedure'))).toBe('TOO_MANY_REQUESTS');
    expect(await call('u2', 'fresh.procedure')).toBe('ok');
  });

  it('fails closed when the limiter cannot answer', async () => {
    unavailable = true;
    expect(await code(call('u1', 'library.list'))).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('protectedProcedure', () => {
  const app = router({ read: protectedProcedure.query(() => 'read') });
  const ctx = (userId: string) => ({ user: { id: userId }, isEmailVerified: true }) as never;

  it('refuses a user who used up this procedure before reading the profile', async () => {
    // The caller has no database: reaching the profile read would fail with another error.
    counts.set('procedure:query|u3:read', PROCEDURE_RATE_LIMITS.query);
    const refused = await code(app.createCaller(ctx('u3')).read());
    expect(refused).toBe('TOO_MANY_REQUESTS');
    expect(check).toHaveBeenCalledWith('procedure:query', 'u3:read', PROCEDURE_RATE_LIMITS.query);
  });
});
