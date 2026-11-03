/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_CACHE_DEADLINE_MS, PROFILE_CACHE_MAX_AGE_S, redisProfileCache, sharedProfileCache, type ProfileRedis } from './profileCache';

// The shared profile cache on Redis (Owner 2026-11-03: a turn may not touch Postgres for it). A double stands in for Upstash: no test
// reaches a network.
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 8, 0, 0);
const profile = (account: string) => ({ fields: { id: account, name: `P ${account}`, followers: 50000 }, missing: [] as string[] });
const stamp = (ms: number) => new Date(ms).toISOString();

function double() {
  const data = new Map<string, unknown>(), ttl = new Map<string, number>();
  const redis = {
    mget: vi.fn(async (...keys: string[]) => keys.map(key => data.get(key) ?? null)),
    set: vi.fn(async (key: string, value: unknown, options?: { ex?: number }) => { data.set(key, value); ttl.set(key, options?.ex ?? 0); return 'OK'; }),
  } as unknown as ProfileRedis & { mget: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  return { redis, data, ttl };
}

describe('the profile cache on Redis', () => {
  it('serves a profile any search wrote, under one key per platform + lookup kind + account, and expires it 24 hours after the supplier answered', async () => {
    const { redis, data, ttl } = double();
    const now = T0 + HOUR;
    const cache = redisProfileCache(redis, () => now);
    await cache.write('tiktok', 'account_profile', [{ account: 'a1', profile: profile('a1'), fetchedAt: stamp(T0) }]);
    expect([...data.keys()]).toEqual(['bench:profile:tiktok:account_profile:a1']);
    expect(ttl.get('bench:profile:tiktok:account_profile:a1')).toBe(PROFILE_CACHE_MAX_AGE_S - 3600);   // counted from the answer, not the write
    const hit = await cache.read('tiktok', 'account_profile', ['a1', 'a2']);
    expect([...hit.keys()]).toEqual(['a1']);
    expect(hit.get('a1')).toEqual({ profile: profile('a1'), fetchedAt: stamp(T0) });
    // Another platform or lookup kind is another key.
    expect((await cache.read('youtube', 'account_profile', ['a1'])).size).toBe(0);
    expect((await cache.read('tiktok', 'post_detail', ['a1'])).size).toBe(0);
  });

  it('a profile older than 24 hours is a miss even if the key has not expired yet, and one already that old is never written', async () => {
    const { redis, data } = double();
    let now = T0;
    const cache = redisProfileCache(redis, () => now);
    await cache.write('tiktok', 'account_profile', [{ account: 'a1', profile: profile('a1'), fetchedAt: stamp(T0) }]);
    now = T0 + 24 * HOUR - 1000;
    expect((await cache.read('tiktok', 'account_profile', ['a1'])).size).toBe(1);
    now = T0 + 24 * HOUR + 1000;
    expect((await cache.read('tiktok', 'account_profile', ['a1'])).size).toBe(0);
    redis.set.mockClear();
    await cache.write('tiktok', 'account_profile', [{ account: 'old', profile: profile('old'), fetchedAt: stamp(T0) }]);
    expect(redis.set).not.toHaveBeenCalled();
    expect(data.has('bench:profile:tiktok:account_profile:old')).toBe(false);
  });

  it('accounts with unusual characters get a safe key; a damaged or future-dated value is a miss', async () => {
    const { redis, data } = double();
    const cache = redisProfileCache(redis, () => T0);
    await cache.write('youtube', 'post_detail', [{ account: 'UC a/b:c', profile: profile('x'), fetchedAt: stamp(T0) }]);
    expect([...data.keys()]).toEqual(['bench:profile:youtube:post_detail:UC%20a%2Fb%3Ac']);
    data.set('bench:profile:tiktok:account_profile:bad', { profile: 'nope', fetchedAt: stamp(T0) });
    data.set('bench:profile:tiktok:account_profile:future', { profile: profile('f'), fetchedAt: stamp(T0 + 2 * HOUR) });
    expect((await cache.read('tiktok', 'account_profile', ['bad', 'future'])).size).toBe(0);
    expect((await cache.read('tiktok', 'account_profile', [])).size).toBe(0);
  });

  it('Redis down, erroring or too slow is a miss and a silent write: the search is never failed or held up', async () => {
    const down = { mget: vi.fn(async () => { throw new Error('redis down'); }), set: vi.fn(async () => { throw new Error('redis down'); }) } as unknown as ProfileRedis;
    const broken = redisProfileCache(down, () => T0);
    expect((await broken.read('tiktok', 'account_profile', ['a1'])).size).toBe(0);
    await expect(broken.write('tiktok', 'account_profile', [{ account: 'a1', profile: profile('a1'), fetchedAt: stamp(T0) }])).resolves.toBeUndefined();
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const slow = redisProfileCache({ mget: vi.fn(() => never), set: vi.fn(() => never) } as unknown as ProfileRedis, () => T0);
      const read = slow.read('tiktok', 'account_profile', ['a1']);
      const write = slow.write('tiktok', 'account_profile', [{ account: 'a1', profile: profile('a1'), fetchedAt: stamp(T0) }]);
      await vi.advanceTimersByTimeAsync(PROFILE_CACHE_DEADLINE_MS + 1);
      expect((await read).size).toBe(0);
      await expect(write).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('the batch of writes goes out together under one deadline', async () => {
    const { redis } = double();
    const cache = redisProfileCache(redis, () => T0);
    await cache.write('tiktok', 'account_profile', ['a', 'b', 'c'].map(account => ({ account, profile: profile(account), fetchedAt: stamp(T0) })));
    expect(redis.set).toHaveBeenCalledTimes(3);
  });

  it('without Redis configured there is no cache, and that is not an error', () => {
    const saved = { ...process.env };
    for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[name];
    try { expect(sharedProfileCache()).toBeNull(); } finally { Object.assign(process.env, saved); }
  });
});
