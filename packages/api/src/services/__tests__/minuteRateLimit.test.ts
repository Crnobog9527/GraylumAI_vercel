/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), options: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class {} }));
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow = vi.fn((count: number, window: string) => `${count}/${window}`);
    constructor(options: unknown) { mocks.options(options); }
    limit = mocks.limit;
  },
}));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn() } }));

describe('checkMinuteRateLimit (ARCH-FIX A1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts under its own prefix per minute, without analytics', async () => {
    mocks.limit.mockResolvedValue({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 });
    const { checkMinuteRateLimit } = await import('../redisRateLimiter');
    expect(await checkMinuteRateLimit('procedure:query', 'u1:library.list', 120)).toMatchObject({ success: true });
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({
      limiter: '120/1 m', prefix: 'graylum:ratelimit:procedure:query:', analytics: false }));
    expect(mocks.limit).toHaveBeenCalledWith('u1:library.list', undefined);
  });

  it('reports an exhausted allowance with a retry hint', async () => {
    mocks.limit.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 30_000 });
    const { checkMinuteRateLimit } = await import('../redisRateLimiter');
    expect(await checkMinuteRateLimit('procedure:mutation', 'u1:x', 60))
      .toMatchObject({ success: false, reason: 'rate_limited', retryAfter: 30 });
  });

  it('fails closed when Redis errors, times out or is not configured', async () => {
    mocks.limit.mockRejectedValueOnce(new Error('down'));
    mocks.limit.mockResolvedValueOnce({ success: true, reason: 'timeout', limit: 1, remaining: 1, reset: 0 });
    const { checkMinuteRateLimit } = await import('../redisRateLimiter');
    expect(await checkMinuteRateLimit('procedure:user', 'u1', 300)).toMatchObject({ success: false, reason: 'unavailable' });
    expect(await checkMinuteRateLimit('procedure:user', 'u1', 300)).toMatchObject({ success: false, reason: 'unavailable' });
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('KV_REST_API_URL', '');
    const fresh = await import('../redisRateLimiter');
    expect(await fresh.checkMinuteRateLimit('procedure:user', 'u1', 300)).toMatchObject({ reason: 'unavailable' });
  });
});
