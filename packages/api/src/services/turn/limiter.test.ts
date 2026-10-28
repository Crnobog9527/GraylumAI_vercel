/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { acquireSlot, type CounterStore } from './limiter';

function memoryStore(fail?: () => boolean): CounterStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async incr(key) { if (fail?.()) throw new Error('down'); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; },
    async decr(key) { const n = (counts.get(key) ?? 0) - 1; counts.set(key, n); return n; },
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
    expect(store.counts.get('turn:inflight:m')).toBe(2);
    // A third call waits; once one slot is freed during its backoff, it gets in.
    const third = acquireSlot(store, 'm', { limit: 2, now: c.now, sleep: async ms => { await c.sleep(ms); await releases[0]!(); } });
    await expect(third).resolves.toBeTypeOf('function');
    expect(c.slept()).toBe(100);
    await releases[0]!(); // idempotent
    expect(store.counts.get('turn:inflight:m')).toBe(2);
  });

  it('refuses after the wait, without leaving a slot taken', async () => {
    const store = memoryStore(), c = clock();
    await acquireSlot(store, 'm', { limit: 1, ...c });
    await expect(acquireSlot(store, 'm', { limit: 1, waitMs: 1000, ...c })).rejects.toThrow('TURN_PROVIDER_BUSY');
    expect(store.counts.get('turn:inflight:m')).toBe(1);
    // 100 + 200 + 400 waited; the next 800 would pass 1000.
    expect(c.slept()).toBe(700);
  });

  it('fails closed when the counter cannot be reached', async () => {
    await expect(acquireSlot(memoryStore(() => true), 'm', { limit: 3 })).rejects.toThrow('TURN_PROVIDER_LIMIT_UNAVAILABLE');
    await expect(acquireSlot(memoryStore(), 'm', { limit: 0 })).rejects.toThrow('TURN_PROVIDER_LIMIT_INVALID');
  });
});
