/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './runtime/rateLimitSettings';
const mock = vi.hoisted(() => ({ limit: vi.fn(), remaining: vi.fn(), construct: vi.fn(), redis: vi.fn(), log: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class { constructor(options: unknown) { mock.redis(options); } } }));
vi.mock('@upstash/ratelimit', () => ({ Ratelimit: class {
  static slidingWindow(count: number, duration: string) { return { count, duration }; }
  constructor(private options: unknown) { mock.construct(options); }
  limit(id: string, rate: unknown) { return mock.limit(this.options, id, rate); }
  getRemaining(id: string) { return mock.remaining(this.options, id); }
} }));
vi.mock('../lib/logger', () => ({ logger: { error: mock.log } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('KV_REST_API_URL', 'https://synthetic.invalid'); vi.stubEnv('KV_REST_API_TOKEN', 'synthetic');
  mock.limit.mockResolvedValue({ success: true, reset: Date.now() + 60000 });
  mock.remaining.mockResolvedValue({ remaining: 30, reset: Date.now() + 60000 });
});
it('prechecks both windows before charging the frozen call budget', async () => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('actor', 'calls', defaults, 'local', 2)).toEqual({ success: true });
  expect(mock.remaining).toHaveBeenCalledTimes(2);
  expect(mock.limit.mock.calls.map(([, id, rate]) => [id, rate])).toEqual([
    ['actor', { rate: 2 }], ['actor', { rate: 2 }],
  ]);
  expect(Math.max(...mock.remaining.mock.invocationCallOrder)).toBeLessThan(mock.limit.mock.invocationCallOrder[0]);
});
it.each(['minute', 'day'])('does not charge either bucket when %s remaining is insufficient', async window => {
  mock.remaining.mockImplementation(async options => ({
    remaining: options.prefix.includes(`:${window}:`) ? 1 : 30, reset: Date.now() + 60000,
  }));
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('actor', 'calls', defaults, 'local', 2)).toEqual({
    success: false, reason: 'rate_limited', window, retryAfter: 60,
  });
  expect(mock.limit).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid or impossible rate %s before Redis', async rate => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('actor', 'calls', defaults, 'local', rate)).toMatchObject({ reason: 'unavailable' });
  expect(mock.redis).not.toHaveBeenCalled();
});
it.each(['error', 'hang', 'invalid'])('fails closed for remaining precheck %s', async mode => {
  vi.useFakeTimers();
  if (mode === 'error') mock.remaining.mockRejectedValue(new Error('private'));
  if (mode === 'hang') mock.remaining.mockImplementation(() => new Promise(() => {}));
  if (mode === 'invalid') mock.remaining.mockResolvedValue({ remaining: NaN, reset: NaN });
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  const pending = check('actor', 'calls', defaults, 'local', 2);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ reason: 'unavailable' });
  expect(mock.limit).not.toHaveBeenCalled();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('checks minute then day with the shared identity and disables analytics and fail-open timers', async () => {
  const { checkRuntimeRateLimit } = await import('./redisRateLimiter');
  expect(await checkRuntimeRateLimit('actor', 'admission', defaults, 'staging')).toEqual({ success: true });
  expect(mock.limit.mock.calls.map(([options, id]) => [options.limiter, id])).toEqual([
    [{ count: 10, duration: '1 m' }, 'actor'], [{ count: 200, duration: '1 d' }, 'actor'],
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
  expect(mock.limit).toHaveBeenCalledTimes(window === 'minute' ? 1 : 2);
  if (window === 'minute') {
    expect(mock.limit.mock.calls.some(([options]) => options.prefix.includes(':day:'))).toBe(false);
  }
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
it.each([{ minute: 2, day: 4 }, { minute: 2, day: 2 }])('diagnoses insufficient capacity without Redis: %j', async limits => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  const config = { ...defaults, callsPerMinute: limits.minute, callsPer24Hours: limits.day };
  expect(await check('actor', 'calls', config, 'local', 3)).toMatchObject({
    success: false, reason: 'usage_configuration_required', retryAfter: 0,
  });
  expect(mock.redis).not.toHaveBeenCalled();
  expect(mock.remaining).not.toHaveBeenCalled();
  expect(mock.limit).not.toHaveBeenCalled();
  expect(await check('actor', 'calls', { ...config, callsPerMinute: 3, callsPer24Hours: 4 }, 'local', 3))
    .toEqual({ success: true });
});
it.each([{ callsPerMinute: 2, callsPer24Hours: 4 }, { callsPerMinute: 2, callsPer24Hours: 2 }])
('accepts equality with minute/day configured capacity: %j', async limits => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  expect(await check('actor', 'calls', { ...defaults, ...limits }, 'local', 2)).toEqual({ success: true });
  expect(mock.limit).toHaveBeenCalledTimes(2);
});
it.each(['minute', 'day'])('ordinary %s window exhaustion remains retryable after reset', async window => {
  const { checkRuntimeRateLimit: check } = await import('./redisRateLimiter');
  mock.remaining.mockImplementation(async options => ({
    remaining: options.prefix.includes(`:${window}:`) ? 1 : 30, reset: Date.now() + 60000,
  }));
  expect(await check('actor', 'calls', defaults, 'local', 2)).toMatchObject({ reason: 'rate_limited', window });
  expect(mock.limit).not.toHaveBeenCalled();
  mock.remaining.mockResolvedValue({ remaining: 30, reset: Date.now() + 60000 });
  expect(await check('actor', 'calls', defaults, 'local', 2)).toEqual({ success: true });
});
