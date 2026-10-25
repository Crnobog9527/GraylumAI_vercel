import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
const logServerError = vi.fn();

vi.mock('@upstash/redis', () => ({ Redis: class {} }));
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow() { return {}; }
    limit = limit;
  },
}));
vi.mock('@/lib/server-log', () => ({ logServerError }));

describe('checkRateLimit failure handling', () => {
  beforeEach(() => {
    vi.resetModules();
    limit.mockReset();
    logServerError.mockReset();
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'secret-token';
  });

  it.each([
    ['timeout', new Error('RATE_LIMIT_TIMEOUT')],
    ['timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
    ['connection', new TypeError('fetch failed')],
    ['quota', new Error('ERR max requests limit exceeded for https://redis.invalid')],
    ['other', new Error('boom secret-token')],
  ])('denies and logs only the %s kind', async (kind, error) => {
    limit.mockRejectedValue(error);
    const { checkRateLimit } = await import('./rateLimit');
    const result = await checkRateLimit('1.2.3.4', 'ip');
    expect(result).toMatchObject({ success: false, reason: 'unavailable' });
    expect(logServerError).toHaveBeenCalledWith(
      'security',
      'web_rate_limit_backend_unavailable_denying_request',
      { failureKind: kind },
    );
  });

  it('denies when Redis is not configured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const { checkRateLimit } = await import('./rateLimit');
    const result = await checkRateLimit('1.2.3.4', 'ip');
    expect(result.success).toBe(false);
    expect(logServerError.mock.calls[0][2]).toEqual({ failureKind: 'unconfigured' });
  });

  it('waits past 500ms but denies at the 1000ms deadline', async () => {
    vi.useFakeTimers();
    limit.mockReturnValue(new Promise(() => {}));
    const { checkRateLimit } = await import('./rateLimit');
    const pending = checkRateLimit('1.2.3.4', 'ip');
    await vi.advanceTimersByTimeAsync(600);
    expect(logServerError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ success: false, reason: 'unavailable' });
    expect(logServerError.mock.calls[0][2]).toEqual({ failureKind: 'timeout' });
    vi.useRealTimers();
  });
});
