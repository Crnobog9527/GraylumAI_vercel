/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPlatformSecret, invalidatePlatformSecret, PLATFORM_SECRET_CACHE_MS,
  resetPlatformSecretCacheForTests,
} from './reader';

// Fake values only.
const STORED = 'or-test-stored-0000aaaa';

function client(reply: () => { data: unknown; error: { code?: string } | null } | Promise<never>) {
  const calls: unknown[] = [];
  const db = {
    rpc: vi.fn((name: string, args: unknown) => {
      calls.push([name, args]);
      return { abortSignal: async () => reply() };
    }),
  };
  return { db: db as never, calls };
}

beforeEach(() => resetPlatformSecretCacheForTests());

describe('getPlatformSecret', () => {
  it('uses the admin Vault value', async () => {
    const { db, calls } = client(() => ({ data: STORED, error: null }));
    const result = await getPlatformSecret(db, 'postforme');
    expect(result).toEqual({ value: STORED, source: 'admin' });
    expect(calls).toEqual([['platform_secret_read', { p_slot: 'postforme' }]]);
  });

  it('reports an empty Vault slot as not configured', async () => {
    const { db } = client(() => ({ data: null, error: null }));
    await expect(getPlatformSecret(db, 'tikhub')).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
  });

  it.each([
    ['an rpc error', () => ({ data: null, error: { code: '42501' } })],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a malformed reply', () => ({ data: 42, error: null })],
  ])('fails on %s instead of serving a stale value', async (_label, reply) => {
    let now = 0;
    let fail = false;
    const { db } = client(() => fail ? reply() : { data: STORED, error: null });
    expect((await getPlatformSecret(db, 'postforme', { now: () => now })).value).toBe(STORED);
    now = PLATFORM_SECRET_CACHE_MS;
    fail = true;
    await expect(getPlatformSecret(db, 'postforme', { now: () => now }))
      .rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
  });

  it('caches for 60 seconds, shares one read between concurrent callers, and invalidates on demand', async () => {
    let now = 0;
    let value = STORED;
    const { db, calls } = client(() => ({ data: value, error: null }));
    const deps = { now: () => now };
    await Promise.all([getPlatformSecret(db, 'tikhub', deps), getPlatformSecret(db, 'tikhub', deps)]);
    expect(calls).toHaveLength(1);
    value = 'tikhub-fake-replaced-value-0001';
    now = PLATFORM_SECRET_CACHE_MS - 1;
    expect((await getPlatformSecret(db, 'tikhub', deps)).value).toBe(STORED);
    now = PLATFORM_SECRET_CACHE_MS;
    expect((await getPlatformSecret(db, 'tikhub', deps)).value).toBe(value);
    invalidatePlatformSecret('tikhub');
    value = 'tikhub-fake-replaced-value-0002';
    expect((await getPlatformSecret(db, 'tikhub', deps)).value).toBe(value);
    expect(calls).toHaveLength(3);
  });

  it('fresh reads the database every time, so a key cleared elsewhere stops working at once (paid-call paths)', async () => {
    let value: string | null = STORED;
    const { db, calls } = client(() => ({ data: value, error: null }));
    expect((await getPlatformSecret(db, 'openrouter')).value).toBe(STORED); // fills this instance's cache
    value = null; // another instance's admin cleared the slot
    expect((await getPlatformSecret(db, 'openrouter')).value).toBe(STORED); // the cache still answers for 60 s
    await expect(getPlatformSecret(db, 'openrouter', { fresh: true })).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
    value = 'or-test-replaced-1111bbbb';
    expect((await getPlatformSecret(db, 'openrouter', { fresh: true })).value).toBe('or-test-replaced-1111bbbb');
    expect(calls).toHaveLength(3);
  });

  it('fresh does not share or poison the cache, and a failed fresh read is an error, not the cached key', async () => {
    const ok = client(() => ({ data: STORED, error: null }));
    await getPlatformSecret(ok.db, 'openrouter');
    const broken = client(() => ({ data: null, error: { code: '57014' } }));
    await expect(getPlatformSecret(broken.db, 'openrouter', { fresh: true })).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    expect((await getPlatformSecret(broken.db, 'openrouter')).value).toBe(STORED); // normal reads keep their cache
    expect(broken.calls).toHaveLength(1);
  });

  it('after a clear, the slot remains not configured', async () => {
    let value: string | null = STORED;
    const { db } = client(() => ({ data: value, error: null }));
    expect((await getPlatformSecret(db, 'firecrawl')).source).toBe('admin');
    value = null;
    invalidatePlatformSecret('firecrawl');
    await expect(getPlatformSecret(db, 'firecrawl')).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
  });

  it('a read that started before a save cannot put the retired key back into the cache', async () => {
    let release!: (reply: { data: string; error: null }) => void;
    let value = 'tikhub-fake-retired-value-0001';
    let slow = true;
    const { db, calls } = client(() => slow
      ? new Promise(resolve => { release = resolve; }) as never
      : { data: value, error: null });
    const early = getPlatformSecret(db, 'tikhub');
    await Promise.resolve();
    // The admin saves a new key on this instance while the early read is still on the wire.
    value = 'tikhub-fake-current-value-0002';
    invalidatePlatformSecret('tikhub');
    slow = false;
    expect((await getPlatformSecret(db, 'tikhub')).value).toBe(value);
    release({ data: 'tikhub-fake-retired-value-0001', error: null });
    expect((await early).value).toBe('tikhub-fake-retired-value-0001');
    // Later callers keep the current key: the late, older result was not cached.
    expect((await getPlatformSecret(db, 'tikhub')).value).toBe(value);
    expect(calls).toHaveLength(2);
  });
});
