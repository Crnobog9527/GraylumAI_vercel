/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createDedupe, LOST_MEMO_SECONDS, MARK_PREFIX, type MarkStore } from './dedupe';

/** A shared store, as Redis is shared between instances; expiry follows the fake clock. */
function memoryStore(clock: { t: number }) {
  const marks = new Map<string, number>();
  const store: MarkStore & { marks: Map<string, number> } = {
    marks,
    async setIfAbsent(key, _value, ttl) {
      const until = marks.get(key);
      if (until !== undefined && until > clock.t) return false;
      marks.set(key, clock.t + ttl * 1000);
      return true;
    },
    async remove(key) { marks.delete(key); },
  };
  return store;
}

describe('createDedupe', () => {
  it('lets one caller per key through, across instances sharing the store', async () => {
    const clock = { t: 0 };
    const store = memoryStore(clock);
    const a = createDedupe(() => store, () => clock.t);
    const b = createDedupe(() => store, () => clock.t);
    expect(await a.claim('refund:ch_1', 60)).toBe(true);
    expect(await a.claim('refund:ch_1', 60)).toBe(false);
    expect(await b.claim('refund:ch_1', 60)).toBe(false);
    expect(await b.claim('refund:ch_2', 60)).toBe(true);
    expect([...store.marks.keys()]).toEqual([`${MARK_PREFIX}refund:ch_1`, `${MARK_PREFIX}refund:ch_2`]);
  });

  it('acts as a cooldown: the same key goes through again once its TTL has passed', async () => {
    const clock = { t: 0 };
    const store = memoryStore(clock);
    const dedupe = createDedupe(() => store, () => clock.t);
    expect(await dedupe.claim('error_spike', 3600)).toBe(true);
    clock.t = 3599_000;
    expect(dedupe.seen('error_spike')).toBe(true);
    expect(await dedupe.claim('error_spike', 3600)).toBe(false);
    clock.t = 3600_000;
    expect(dedupe.seen('error_spike')).toBe(false);
    expect(await dedupe.claim('error_spike', 3600)).toBe(true);
  });

  it('frees a key after a failed send so a redelivery can try again', async () => {
    const clock = { t: 0 };
    const store = memoryStore(clock);
    const dedupe = createDedupe(() => store, () => clock.t);
    expect(await dedupe.claim('k', 60)).toBe(true);
    await dedupe.release('k');
    expect(store.marks.size).toBe(0);
    expect(await dedupe.claim('k', 60)).toBe(true);
  });

  it('an instance that lost the race competes again soon, so a retry after the owner released the key is not lost', async () => {
    const clock = { t: 0 };
    const store = memoryStore(clock);
    const a = createDedupe(() => store, () => clock.t);
    const b = createDedupe(() => store, () => clock.t);
    expect(await a.claim('refund:ch_1', 4 * 86400)).toBe(true);
    expect(await b.claim('refund:ch_1', 4 * 86400)).toBe(false);
    await a.release('refund:ch_1');
    clock.t = (LOST_MEMO_SECONDS - 1) * 1000;
    expect(await b.claim('refund:ch_1', 4 * 86400)).toBe(false);
    clock.t = LOST_MEMO_SECONDS * 1000;
    expect(await b.claim('refund:ch_1', 4 * 86400)).toBe(true);
    // While the owner's mark stands, the loser keeps losing (one Redis call a minute at most).
    clock.t += LOST_MEMO_SECONDS * 1000;
    expect(await a.claim('refund:ch_1', 4 * 86400)).toBe(false);
  });

  it('still sends when Redis is down or missing, but not twice from the same instance', async () => {
    const broken = createDedupe(() => ({
      setIfAbsent: async () => { throw new Error('down'); }, remove: async () => { throw new Error('down'); },
    }));
    expect(await broken.claim('k', 60)).toBe(true);
    expect(await broken.claim('k', 60)).toBe(false);
    await expect(broken.release('k')).resolves.toBeUndefined();
    const throwing = createDedupe(() => { throw new Error('REDIS_ENV_INCOMPLETE'); });
    expect(await throwing.claim('k', 60)).toBe(true);
    expect(await createDedupe(() => null).claim('k', 60)).toBe(true);
  });
});
