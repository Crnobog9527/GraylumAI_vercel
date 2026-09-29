import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), options: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class {} }));
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow = vi.fn(() => 'window');
    constructor(options: unknown) { mocks.options(options); }
    limit = mocks.limit;
  },
}));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const loaders = [
  ['API', () => import('../redisRateLimiter')],
  ['Web', () => import('@/lib/rateLimit')],
] as const;
for (const [name, load] of loaders) {
  describe(`${name} distributed rate limiter`, () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
      vi.stubEnv('RATE_LIMIT_FAIL_CLOSED', 'false');
      mocks.limit.mockResolvedValue({ success: true, limit: 20, remaining: 19, reset: Date.now() + 60000 });
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

    for (const type of ['ai', 'ai_stream', 'api', 'auth', 'anonymous'] as const) {
      it(`${type}: permits healthy requests`, async () => {
        const { checkRateLimit } = await load();
        expect(await checkRateLimit('user', type)).toMatchObject({ success: true, limit: 20 });
      });
      it(`${type}: rejects exhausted allowance`, async () => {
        mocks.limit.mockResolvedValue({ success: false, limit: 20, remaining: 0, reset: Date.now() + 60000 });
        const { checkRateLimit } = await load();
        expect(await checkRateLimit('user', type)).toMatchObject({ success: false, reason: 'rate_limited', retryAfter: 60 });
      });
      it(`${type}: rejects backend errors even with the old opt-out`, async () => {
        mocks.limit.mockRejectedValue(new Error('synthetic backend failure'));
        const { checkRateLimit } = await load();
        expect(await checkRateLimit('user', type)).toMatchObject({ success: false, reason: 'unavailable', retryAfter: 60 });
      });
      it(`${type}: rejects the SDK timeout success sentinel`, async () => {
        mocks.limit.mockResolvedValue({ success: true, reason: 'timeout', limit: 0, remaining: 0, reset: 0 });
        const { checkRateLimit } = await load();
        expect(await checkRateLimit('user', type)).toMatchObject({ success: false, reason: 'unavailable' });
      });
      it(`${type}: bounds a hanging backend to 500ms`, async () => {
        vi.useFakeTimers();
        mocks.limit.mockImplementation(() => new Promise(() => {}));
        const { checkRateLimit } = await load();
        const pending = checkRateLimit('user', type);
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ success: false, reason: 'unavailable', retryAfter: 60 });
        expect(vi.getTimerCount()).toBe(0);
      });
    }
    it.each(['development', 'test', 'production'])('rejects missing configuration in %s', async env => {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
      const { checkRateLimit } = await load();
      expect(await checkRateLimit('user')).toMatchObject({ success: false, reason: 'unavailable', retryAfter: 60 });
      expect(mocks.limit).not.toHaveBeenCalled();
    });
    it('rejects missing configuration in deployed staging regardless of NODE_ENV', async () => {
      vi.stubEnv('VERCEL_ENV', 'preview');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
      const { checkRateLimit } = await load();
      expect(await checkRateLimit('user')).toMatchObject({ success: false, reason: 'unavailable' });
    });
  });
}

describe('API rejection adapters', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('returns HTTP 503 with a retry interval', async () => {
    const { checkRateLimitForMiddleware } = await import('../redisRateLimiter');
    const response = await checkRateLimitForMiddleware('user');
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('60');
    expect(await response?.json()).toMatchObject({ retryAfter: 60 });
  });
  it('preserves unavailable rejection through the async security wrapper', async () => {
    const { checkRateLimitAsync } = await import('../../middleware/securityChecks');
    await expect(checkRateLimitAsync('user')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE', cause: { retryAfter: 60 },
    });
  });
});
