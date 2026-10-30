/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { acquireSlot, type CounterStore } from './limiter';

function memoryStore(fail?: () => boolean): CounterStore & { live: (key: string) => number } {
  const sets = new Map<string, Map<string, number>>();
  return {
    live: key => sets.get(key)?.size ?? 0,
    async take(key, member, nowMs, expiresAtMs) {
      if (fail?.()) throw new Error('down');
      const set = sets.get(key) ?? new Map<string, number>();
      for (const [m, expiry] of set) if (expiry <= nowMs) set.delete(m);
      set.set(member, expiresAtMs); sets.set(key, set);
      return set.size;
    },
    async drop(key, member) { sets.get(key)?.delete(member); },
  };
}
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, slept: () => t };
};

describe('per-model in-flight limit (CORE-PATH-V2 3.3.2 item 10)', () => {
  it('admits up to the limit, waits with backoff above it, and frees the slot on release', async () => {
    const store = memoryStore(), c = clock();
    const releases = await Promise.all([1, 2].map(() => acquireSlot(store, 'm', { limit: 2, ...c })));
    expect(store.live('turn:inflight:m')).toBe(2);
    // A third call waits; once one slot is freed during its backoff, it gets in.
    const third = acquireSlot(store, 'm', { limit: 2, now: c.now, sleep: async ms => { await c.sleep(ms); await releases[0]!(); } });
    await expect(third).resolves.toBeTypeOf('function');
    expect(c.slept()).toBe(100);
    await releases[0]!(); // idempotent
    expect(store.live('turn:inflight:m')).toBe(2);
  });

  it('refuses after the wait, without leaving a slot taken', async () => {
    const store = memoryStore(), c = clock();
    await acquireSlot(store, 'm', { limit: 1, ...c });
    await expect(acquireSlot(store, 'm', { limit: 1, waitMs: 1000, ...c })).rejects.toThrow('TURN_PROVIDER_BUSY');
    expect(store.live('turn:inflight:m')).toBe(1);
    // 100 + 200 + 400 waited; the next 800 would pass 1000.
    expect(c.slept()).toBe(700);
  });

  it('slots left by an instance that died expire on their own, even while requests keep arriving', async () => {
    const store = memoryStore(), c = clock();
    // An instance takes every slot and exits without releasing any.
    for (let i = 0; i < 20; i++) await acquireSlot(store, 'm', { limit: 20, ...c });
    // Steady traffic every 10 s is refused (busy) until the abandoned slots pass their 600 s expiry, then admitted.
    let admitted: number | undefined;
    for (let t = 0; t < 700 && admitted === undefined; t += 10) {
      try { await acquireSlot(store, 'm', { limit: 20, waitMs: 0, ...c }); admitted = c.now(); }
      catch (error) { expect((error as Error).message).toBe('TURN_PROVIDER_BUSY'); await c.sleep(10_000); }
    }
    expect(admitted).toBeGreaterThanOrEqual(600_000);
    expect(admitted).toBeLessThan(620_000);
    expect(store.live('turn:inflight:m')).toBe(1);
  });

  it('fails closed when the counter cannot be reached', async () => {
    await expect(acquireSlot(memoryStore(() => true), 'm', { limit: 3 })).rejects.toThrow('TURN_PROVIDER_LIMIT_UNAVAILABLE');
    await expect(acquireSlot(memoryStore(), 'm', { limit: 0 })).rejects.toThrow('TURN_PROVIDER_LIMIT_INVALID');
  });
});
