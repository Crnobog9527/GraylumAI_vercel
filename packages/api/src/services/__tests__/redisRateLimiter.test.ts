import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLimit = vi.fn();
const mockRedis = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: mockRedis,
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class MockRateLimit {
    static slidingWindow = vi.fn(() => 'window');
    constructor() {}
    limit = mockLimit;
  },
}));

const ORIGINAL_ENV = { ...process.env };

describe('redisRateLimiter', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLimit.mockReset();
    mockRedis.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws INTERNAL_SERVER_ERROR when the rate limit backend is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    mockLimit.mockRejectedValue(new Error('redis down'));

    const { checkRateLimitOrThrow } = await import('../redisRateLimiter');

    await expect(checkRateLimitOrThrow('user-1', 'api')).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '速率限制服务暂时不可用，请稍后再试',
    });
  });

  it('returns a 503 middleware response when the rate limit backend is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    mockLimit.mockRejectedValue(new Error('redis down'));

    const { checkRateLimitForMiddleware } = await import('../redisRateLimiter');
    const response = await checkRateLimitForMiddleware('user-1', 'api');

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      error: 'Service Unavailable',
      message: '速率限制服务暂时不可用，请稍后再试',
      retryAfter: 60,
    });
  });
});
