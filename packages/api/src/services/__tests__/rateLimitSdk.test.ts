import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real @upstash/ratelimit code with an offline Redis command adapter.
const redis = vi.hoisted(() => ({ evalsha: vi.fn(), zincrby: vi.fn(), config: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class {
  constructor(options: unknown) { redis.config(options); }
  evalsha = redis.evalsha;
  zincrby = redis.zincrby;
} }));

for (const [name, load] of [
  ['API', () => import('../redisRateLimiter')],
  ['Web', () => import('@/lib/rateLimit')],
] as const) {
  describe(`${name} real SDK / fake Redis`, () => {
    beforeEach(() => {
      vi.resetModules(); vi.clearAllMocks();
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
      redis.zincrby.mockResolvedValue(1);
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
    it.each([[19, true], [-1, false]])('handles remaining tokens %s', async (remaining, success) => {
      redis.evalsha.mockResolvedValue([remaining, 20]);
      const { checkRateLimit } = await load();
      expect(await checkRateLimit('user', 'ai_stream')).toMatchObject({ success, limit: 20 });
      expect(redis.evalsha).toHaveBeenCalled();
      expect(redis.config).toHaveBeenCalledWith(expect.objectContaining({ retry: { retries: 0 }, signal: expect.any(Function) }));
    });
    it('rejects Redis command failures', async () => {
      redis.evalsha.mockRejectedValue(new Error('synthetic offline Redis error'));
      const { checkRateLimit } = await load();
      expect(await checkRateLimit('user')).toMatchObject({ success: false, reason: 'unavailable' });
    });
    it('returns within 500ms when Redis never resolves', async () => {
      vi.useFakeTimers();
      redis.evalsha.mockImplementation(() => new Promise(() => {}));
      const { checkRateLimit } = await load();
      const pending = checkRateLimit('user');
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ success: false, reason: 'unavailable', retryAfter: 60 });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}
