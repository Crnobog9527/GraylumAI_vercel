/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPlatformSecret, invalidatePlatformSecret, PLATFORM_SECRET_CACHE_MS, PlatformSecretError,
  resetPlatformSecretCacheForTests,
} from './reader';

// Fake values only.
const STORED = 'sk-or-v1-fake-stored-0000aaaa';
const ENV_KEY = 'pfm_test_fakeenvvalue1234';

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
  it('uses the admin value and ignores the environment when the admin filled the slot', async () => {
    const { db, calls } = client(() => ({ data: STORED, error: null }));
    const result = await getPlatformSecret(db, 'postforme', { env: { POSTFORME_API_KEY: ENV_KEY } });
    expect(result).toEqual({ value: STORED, source: 'admin' });
    expect(calls).toEqual([['platform_secret_read', { p_slot: 'postforme' }]]);
  });

  it('falls back to the allowed environment variable while the admin slot is empty', async () => {
    const { db } = client(() => ({ data: null, error: null }));
    expect(await getPlatformSecret(db, 'postforme', { env: { POSTFORME_API_KEY: ` ${ENV_KEY} ` } }))
      .toEqual({ value: ENV_KEY, source: 'env' });
    for (const [slot, name] of [['tikhub', 'TIKHUB_API_KEY'], ['parallel', 'PARALLEL_API_KEY'],
      ['firecrawl', 'FIRECRAWL_API_KEY']] as const) {
      expect((await getPlatformSecret(db, slot, { env: { [name]: ENV_KEY } })).source).toBe('env');
    }
  });

  it('never falls back to an environment key for OpenRouter', async () => {
    const { db } = client(() => ({ data: null, error: null }));
    const error = await getPlatformSecret(db, 'openrouter', { env: { OPENROUTER_API_KEY: 'sk-or-v1-fake-env-1234' } })
      .catch(e => e);
    expect(error).toBeInstanceOf(PlatformSecretError);
    expect(error).toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED', slot: 'openrouter' });
  });

  it('reports not configured when neither the admin nor the environment has a value', async () => {
    const { db } = client(() => ({ data: null, error: null }));
    await expect(getPlatformSecret(db, 'tikhub', { env: { TIKHUB_API_KEY: '  ' } }))
      .rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
  });

  it.each([
    ['an rpc error', () => ({ data: null, error: { code: '42501' } })],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a malformed reply', () => ({ data: 42, error: null })],
  ])('fails on %s instead of using the environment or a stale value', async (_label, reply) => {
    let now = 0;
    let fail = false;
    const { db } = client(() => fail ? reply() : { data: STORED, error: null });
    expect((await getPlatformSecret(db, 'postforme', { now: () => now })).value).toBe(STORED);
    now = PLATFORM_SECRET_CACHE_MS;
    fail = true;
    await expect(getPlatformSecret(db, 'postforme', { now: () => now, env: { POSTFORME_API_KEY: ENV_KEY } }))
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

  it('after a clear, the cached "not filled" result falls back to the environment', async () => {
    let value: string | null = STORED;
    const { db } = client(() => ({ data: value, error: null }));
    const env = { FIRECRAWL_API_KEY: 'fc-fake-environment-value-01' };
    expect((await getPlatformSecret(db, 'firecrawl', { env })).source).toBe('admin');
    value = null;
    invalidatePlatformSecret('firecrawl');
    expect(await getPlatformSecret(db, 'firecrawl', { env })).toEqual({ value: env.FIRECRAWL_API_KEY, source: 'env' });
    await expect(getPlatformSecret(db, 'firecrawl', { env: {} })).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
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
