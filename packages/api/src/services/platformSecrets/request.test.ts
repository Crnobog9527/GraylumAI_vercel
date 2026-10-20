/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { getPlatformSecret, invalidatePlatformSecret, resetPlatformSecretCacheForTests } from './reader';
import { withPlatformSecretRequest } from './request';

const OLD = 'synthetic-old-key';
const NEXT = 'synthetic-next-key';
function fixture() {
  let value: string | null = OLD;
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: value, error: null }) }));
  const db = { rpc } as never;
  return { db, rpc, set: (next: string | null) => { value = next; } };
}
const read = (db: never) => getPlatformSecret(db, 'openrouter', { fresh: true });
beforeEach(resetPlatformSecretCacheForTests);

it('shares a single in-flight fresh read and its later calls in one request', async () => {
  const f = fixture();
  await withPlatformSecretRequest(async () => {
    expect(await Promise.all([read(f.db), read(f.db), read(f.db)])).toEqual(Array(3).fill({ value: OLD, source: 'admin' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await read(f.db)).value).toBe(OLD);
  });
  expect(f.rpc).toHaveBeenCalledTimes(1);
});

it('a replacement applies to the next request even with the same client and no local invalidation', async () => {
  const f = fixture();
  await getPlatformSecret(f.db, 'openrouter'); // old 60-second cache must not authorize the new request
  await withPlatformSecretRequest(async () => {
    expect((await read(f.db)).value).toBe(OLD);
    f.set(NEXT);
    expect((await read(f.db)).value).toBe(OLD); // authorized request snapshot, not another fresh RPC
  });
  expect((await withPlatformSecretRequest(() => read(f.db))).value).toBe(NEXT);
  expect(f.rpc).toHaveBeenCalledTimes(3); // legacy seed, first request, next request
});

it('a cleared key immediately denies the next request and a later replacement is read again', async () => {
  const f = fixture();
  await withPlatformSecretRequest(async () => {
    expect((await read(f.db)).value).toBe(OLD);
    f.set(null);
    invalidatePlatformSecret('openrouter');
    expect((await read(f.db)).value).toBe(OLD);
  });
  await withPlatformSecretRequest(async () => {
    await expect(read(f.db)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
    await expect(read(f.db)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
  });
  f.set(NEXT);
  expect((await withPlatformSecretRequest(() => read(f.db))).value).toBe(NEXT);
  expect(f.rpc).toHaveBeenCalledTimes(3);
});

it('parallel requests do not share pending reads, values or a failed request', async () => {
  let release!: (value: { data: string; error: null }) => void;
  const rpc = vi.fn().mockReturnValueOnce({ abortSignal: () => new Promise(resolve => { release = resolve; }) })
    .mockReturnValueOnce({ abortSignal: async () => ({ data: NEXT, error: null }) });
  const db = { rpc } as never;
  const early = withPlatformSecretRequest(async () => {
    const first = await read(db);
    expect((await read(db)).value).toBe(OLD);
    return first;
  });
  expect((await withPlatformSecretRequest(() => read(db))).value).toBe(NEXT);
  release({ data: OLD, error: null });
  expect((await early).value).toBe(OLD);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('a failed request keeps the same refusal and the next request can recover', async () => {
  let broken = true;
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: broken ? null : NEXT,
    error: broken ? { code: '42501' } : null }) }));
  const db = { rpc } as never;
  await withPlatformSecretRequest(async () => {
    const replies = await Promise.allSettled([read(db), read(db)]);
    expect(replies.map(x => x.status)).toEqual(['rejected', 'rejected']);
    broken = false;
    await expect(read(db)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
  });
  expect((await withPlatformSecretRequest(() => read(db))).value).toBe(NEXT);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('keeps slots and clients isolated within a request', async () => {
  const a = fixture(), b = fixture(); b.set(NEXT);
  await withPlatformSecretRequest(async () => {
    expect((await read(a.db)).value).toBe(OLD);
    expect((await read(b.db)).value).toBe(NEXT);
    expect((await getPlatformSecret(a.db, 'tikhub', { fresh: true })).value).toBe(OLD);
  });
  expect(a.rpc).toHaveBeenCalledTimes(2);
  expect(b.rpc).toHaveBeenCalledTimes(1);
});

it('unscoped fresh calls still read every time, and nested request boundaries start fresh', async () => {
  const f = fixture();
  await read(f.db); await read(f.db);
  await withPlatformSecretRequest(async () => {
    expect((await read(f.db)).value).toBe(OLD);
    f.set(NEXT);
    expect((await withPlatformSecretRequest(() => read(f.db))).value).toBe(NEXT);
    expect((await read(f.db)).value).toBe(OLD);
  });
  expect(f.rpc).toHaveBeenCalledTimes(4);
});
