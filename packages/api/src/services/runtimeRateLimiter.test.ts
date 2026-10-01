/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './runtime/rateLimitSettings';
const mock = vi.hoisted(() => ({ limit: vi.fn(), construct: vi.fn(), redis: vi.fn(), log: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class { constructor(options: unknown) { mock.redis(options); } } }));
vi.mock('@upstash/ratelimit', () => ({ Ratelimit: class {
  static slidingWindow(count: number, duration: string) { return { count, duration }; }
  constructor(private options: unknown) { mock.construct(options); }
  limit(id: string) { return mock.limit(this.options, id); }
} }));
vi.mock('../lib/logger', () => ({ logger: { error: mock.log } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('KV_REST_API_URL', 'https://synthetic.invalid'); vi.stubEnv('KV_REST_API_TOKEN', 'synthetic');
  mock.limit.mockResolvedValue({ success: true, reset: Date.now() + 60000 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('checks day then minute with the shared identity and disables analytics and fail-open timers', async () => {
  const { checkRuntimeRateLimit } = await import('./redisRateLimiter');
  expect(await checkRuntimeRateLimit('actor', 'admission', defaults, 'staging')).toEqual({ success: true });
  expect(mock.limit.mock.calls.map(([options, id]) => [options.limiter, id])).toEqual([
    [{ count: 200, duration: '1 d' }, 'actor'], [{ count: 10, duration: '1 m' }, 'actor'],
  ]);
  expect(mock.construct.mock.calls.every(([v]) => !v.analytics && v.ephemeralCache === false && v.timeout === 0)).toBe(true);
  expect(mock.redis).toHaveBeenCalledWith(expect.objectContaining({
    url: 'https://synthetic.invalid', token: 'synthetic', retry: { retries: 0 },
  }));
});
it('reuses a pair but rebuilds on config change without changing keys; separates environment and bucket', async () => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  await check('a', 'admission', defaults, 'staging');
  await check('b', 'admission', defaults, 'staging');
  expect(mock.construct).toHaveBeenCalledTimes(2);
  await check('a', 'admission', { ...defaults, admissionPerMinute: 5 }, 'staging');
  expect(mock.construct).toHaveBeenCalledTimes(4);
  const prefixes = mock.construct.mock.calls.map(([v]) => v.prefix);
  expect(prefixes.slice(0, 2)).toEqual(prefixes.slice(2));
  await check('a', 'calls', defaults, 'staging');
  await check('a', 'admission', defaults, 'production');
  expect(new Set(mock.construct.mock.calls.map(([v]) => v.prefix)).size).toBe(6);
  expect(mock.construct.mock.calls[4][0].limiter.count).toBe(30);
  expect(mock.construct.mock.calls[5][0].limiter.count).toBe(600);
});
it.each(['day', 'minute'])('returns %s denial and never calls later windows', async window => {
  mock.limit.mockImplementation(async options => ({ success: !options.prefix.includes(`:${window}:`), reset: Date.now() + 60000 }));
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('a', 'admission', defaults, 'staging')).toEqual({
    success: false, reason: 'rate_limited', window, retryAfter: 60,
  });
  expect(mock.limit).toHaveBeenCalledTimes(window === 'day' ? 1 : 2);
  expect(mock.log).not.toHaveBeenCalled();
});
it.each(['error', 'sdk-timeout', 'missing-config'])('fails closed for %s without raw details in logs', async mode => {
  if (mode === 'error') mock.limit.mockRejectedValue(new Error('PRIVATE_SYNTHETIC_DETAIL'));
  if (mode === 'sdk-timeout') mock.limit.mockResolvedValue({ success: true, reason: 'timeout' });
  if (mode === 'missing-config') vi.stubEnv('KV_REST_API_TOKEN', '');
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('a', 'admission', defaults, 'staging')).toEqual({
    success: false, reason: 'unavailable', retryAfter: 60,
  });
  expect(mock.log).toHaveBeenCalledWith('security', 'runtime_rate_limit_backend_unavailable_denying_request');
  expect(JSON.stringify(mock.log.mock.calls)).not.toContain('PRIVATE_SYNTHETIC_DETAIL');
});
it('bounds a hanging backend, without retry or a second window', async () => {
  vi.useFakeTimers(); mock.limit.mockImplementation(() => new Promise(() => {}));
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  const pending = check('a', 'admission', defaults, 'staging');
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ success: false, reason: 'unavailable' });
  expect(mock.limit).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects invalid thresholds and namespaces before Redis', async () => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  await check('a', 'admission', { ...defaults, admissionPerMinute: 0 }, 'staging');
  await check('a', 'admission', defaults, 'arbitrary' as never);
  expect(mock.redis).not.toHaveBeenCalled();
});
