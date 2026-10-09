/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErasureStorageAdapter, isCanonicalErasureAttachment,
  type ErasureAttachmentManifest, type ErasureStorageLimits, type ErasureStorageTransport } from './storage';

const actor = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const file = (name: string, owner = actor) => `${owner}/${name}.png`;
const entry = (path: string, uploaderId = admin, subjectId = actor) => ({ path, uploaderId, subjectId });
function setup(initial: string[] = [], items: ReturnType<typeof entry>[] = [], limits: Partial<ErasureStorageLimits> = {}) {
  const objects = new Set(initial);
  const events: string[] = [];
  const states = new Map<string, 'exclusive' | 'unreferenced' | 'shared' | 'unknown'>();
  const storage = {
    listPrefix: vi.fn<ErasureStorageTransport['listPrefix']>(async ({ bucket, prefix, afterPath, limit }) => {
      expect(bucket).toBe('ticket-attachments'); events.push('list');
      const all = [...objects].filter(path => path.startsWith(prefix) && (!afterPath || path > afterPath)).sort();
      const paths = all.slice(0, limit);
      return { paths, nextAfterPath: all.length > paths.length ? paths.at(-1) : null };
    }),
    remove: vi.fn<ErasureStorageTransport['remove']>(async ({ bucket, paths }) => {
      expect(bucket).toBe('ticket-attachments'); events.push('remove');
      for (const path of paths) objects.delete(path);
    }),
    getState: vi.fn<ErasureStorageTransport['getState']>(async ({ bucket, path }) => {
      expect(bucket).toBe('ticket-attachments'); events.push('read');
      return objects.has(path) ? 'present' : 'absent';
    }),
  };
  const manifest = {
    list: vi.fn<ErasureAttachmentManifest['list']>(async ({ profileId, cursor, limit }) => {
      expect(profileId).toBe(actor);
      const start = cursor === null ? 0 : Number(cursor);
      const selected = items.slice(start, start + limit);
      return { items: selected, nextCursor: start + selected.length < items.length ? String(start + selected.length) : null };
    }),
    classify: vi.fn<ErasureAttachmentManifest['classify']>(async ({ profileId, paths }) => {
      expect(profileId).toBe(actor);
      return paths.map(path => ({ path, state: states.get(path) ??
        (items.some(item => item.path === path && item.subjectId === actor) ? 'exclusive' : 'unreferenced') }));
    }),
  };
  const adapter = createErasureStorageAdapter({ storage, manifest, limits });
  return { objects, events, states, storage, manifest, clean: () => adapter.cleanSubject(actor) };
}
afterEach(() => vi.useRealTimers());

describe('bounded erasure storage with synthetic adapters only', () => {
  it('deletes prefix orphans and explicitly owned administrator reply attachments, then reads absence', async () => {
    const adminFile = file('reply', admin);
    const t = setup([file('orphan'), adminFile, file('unrelated', other)], [entry(adminFile)]);
    expect(await t.clean()).toEqual({ complete: true, remaining: 0, manualReview: 0 });
    expect([...t.objects]).toEqual([file('unrelated', other)]);
    expect(t.events).toEqual(['list', 'read', 'remove', 'read', 'read', 'remove', 'read']);
  });

  it('uses keyset pages so deletion does not skip shifted offset rows', async () => {
    const t = setup(['a', 'b', 'c', 'd', 'e'].map(name => file(name)), [], { pageSize: 2 });
    expect((await t.clean()).complete).toBe(true);
    expect(t.objects.size).toBe(0);
    expect(t.storage.listPrefix.mock.calls.map(([input]) => input.afterPath)).toEqual([null, file('b'), file('d')]);
  });

  it('preserves shared prefix objects and shared administrator replies', async () => {
    const reply = file('reply', admin);
    const t = setup([file('shared'), file('orphan'), reply], [entry(reply)]);
    t.states.set(file('shared'), 'shared'); t.states.set(reply, 'shared');
    expect(await t.clean()).toEqual({ complete: false, remaining: 2, manualReview: 2 });
    expect([...t.objects].sort()).toEqual([file('shared'), reply].sort());
  });

  it('never deletes an administrator object on unreferenced or unknown classification', async () => {
    for (const state of ['unreferenced', 'unknown'] as const) {
      const reply = file('reply', admin); const t = setup([reply], [entry(reply)]);
      t.states.set(reply, state);
      expect((await t.clean()).manualReview).toBe(1);
      expect(t.storage.remove).not.toHaveBeenCalled();
    }
  });

  it('rejects legacy URLs, encoded and ambiguous paths without fetching or deleting them', async () => {
    const invalid = [
      'https://example.invalid/private.png', `${actor}/%2e%2e/a`, `${actor}/a%2fb.png`,
      `${actor}\\a.png`, `${actor}//a.png`, `${actor}/./a.png`, `${actor}/../a.png`,
      `${actor}/a/../b.png`, `${actor}/a.png?x=1`, `${actor}/a.png#fragment`,
      `${actor}/a..png`, `${actor}/.`, `${actor}/..`, `/${actor}/a.png`, `${actor}/a png`,
    ];
    const t = setup([], invalid.map(path => entry(path, actor)));
    expect((await t.clean()).manualReview).toBe(invalid.length);
    expect(t.storage.remove).not.toHaveBeenCalled(); expect(t.storage.getState).not.toHaveBeenCalled();
    for (const path of invalid) expect(isCanonicalErasureAttachment(path)).toBe(false);
  });

  it('rejects cross-subject and incorrect uploader manifest claims', async () => {
    const t = setup([], [entry(file('a', admin), admin, other), entry(file('b', other), admin)]);
    expect(await t.clean()).toEqual({ complete: false, remaining: 2, manualReview: 2 });
    expect(t.manifest.classify).not.toHaveBeenCalled(); expect(t.storage.remove).not.toHaveBeenCalled();
  });

  it('does not trust a cross-prefix object returned by the prefix adapter', async () => {
    const t = setup();
    t.storage.listPrefix.mockResolvedValue({ paths: [file('foreign', other)], nextAfterPath: null });
    expect((await t.clean()).manualReview).toBe(1);
    expect(t.storage.remove).not.toHaveBeenCalled();
  });

  it('does not treat a successful remove response as proof of absence', async () => {
    const t = setup([file('a')]); t.storage.remove.mockResolvedValue({ ok: true });
    expect(await t.clean()).toEqual({ complete: false, remaining: 1, manualReview: 0 });
    expect(t.storage.getState).toHaveBeenCalledTimes(2);
  });

  it('keeps unknown read results incomplete and does not blindly retry a failed removal', async () => {
    const t = setup([file('a')]); t.storage.getState.mockResolvedValue('unknown');
    expect((await t.clean()).complete).toBe(false);
    const failed = setup([file('a')]); failed.storage.remove.mockRejectedValue(new Error('synthetic'));
    expect((await failed.clean()).complete).toBe(false);
    expect(failed.storage.remove).toHaveBeenCalledTimes(1);
  });

  it('can re-inventory after deletion succeeded but its result was lost', async () => {
    const t = setup([file('a')]);
    t.storage.remove.mockImplementationOnce(async ({ paths }) => {
      for (const path of paths) t.objects.delete(path);
      throw new Error('synthetic lost response');
    });
    expect((await t.clean()).complete).toBe(false);
    expect(await t.clean()).toEqual({ complete: true, remaining: 0, manualReview: 0 });
  });

  it('reads an administrator manifest object before retrying an uncertain deletion', async () => {
    const path = file('reply', admin); const t = setup([path], [entry(path)]);
    t.storage.remove.mockImplementationOnce(async () => {
      t.objects.delete(path); throw new Error('synthetic lost response');
    });
    expect((await t.clean()).complete).toBe(false);
    expect((await t.clean()).complete).toBe(true);
    expect(t.storage.remove).toHaveBeenCalledTimes(1);
  });

  it('requires exact complete reference results', async () => {
    for (const response of [[], [{ path: file('other'), state: 'exclusive' }], null]) {
      const t = setup([file('a')]); t.manifest.classify.mockResolvedValue(response);
      expect((await t.clean()).complete).toBe(false); expect(t.storage.remove).not.toHaveBeenCalled();
    }
  });

  it('deduplicates manifest paths and never deletes a previously retained shared path', async () => {
    const path = file('a'); const t = setup([path], [entry(path, actor), entry(path, actor)]);
    t.states.set(path, 'shared');
    expect((await t.clean()).manualReview).toBe(1); expect(t.storage.remove).not.toHaveBeenCalled();
    const adminPath = file('a', admin);
    const duplicate = setup([adminPath], [entry(adminPath), entry(adminPath)]);
    expect((await duplicate.clean()).complete).toBe(true);
    expect(duplicate.storage.remove.mock.calls[0][0].paths).toEqual([adminPath]);
  });

  it('enforces page and object budgets without claiming completion', async () => {
    const t = setup([file('a'), file('b')], [], { pageSize: 1, maxPages: 1 });
    expect((await t.clean()).complete).toBe(false); expect([...t.objects]).toEqual([file('b')]);
    const objects = setup([file('a'), file('b')], [], { maxObjects: 1 });
    expect((await objects.clean()).complete).toBe(false); expect(objects.storage.remove).not.toHaveBeenCalled();
  });

  it('rejects non-progressing or oversized inventory pages', async () => {
    const t = setup([file('a')]);
    t.storage.listPrefix.mockResolvedValue({ paths: [file('a')], nextAfterPath: file('a') });
    expect((await t.clean()).complete).toBe(false); expect(t.storage.remove).toHaveBeenCalledTimes(1);
    const manifest = setup([], [entry(file('a', admin))]); manifest.manifest.list.mockResolvedValue({ items: [entry(file('a', admin))], nextCursor: 'same' });
    expect((await manifest.clean()).complete).toBe(false); expect(manifest.manifest.list).toHaveBeenCalledTimes(2);
    const oversized = setup([], [], { pageSize: 1 });
    oversized.storage.listPrefix.mockResolvedValue({ paths: [file('a'), file('b')], nextAfterPath: null });
    expect((await oversized.clean()).complete).toBe(false); expect(oversized.storage.remove).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive request and aborts it even if the injected adapter ignores cancellation', async () => {
    vi.useFakeTimers();
    const t = setup([], [], { requestTimeoutMs: 10 });
    let signal: AbortSignal | undefined;
    t.storage.listPrefix.mockImplementation(input => { signal = input.signal; return new Promise(() => {}); });
    const pending = t.clean(); await vi.advanceTimersByTimeAsync(11);
    expect((await pending).complete).toBe(false); expect(signal?.aborted).toBe(true);
    expect(t.storage.remove).not.toHaveBeenCalled();
  });

  it('stops before destructive work when the total budget expires during classification', async () => {
    vi.useFakeTimers();
    const t = setup([file('a')], [], { totalTimeoutMs: 10, requestTimeoutMs: 100 });
    t.manifest.classify.mockImplementation(() => new Promise(() => {}));
    const pending = t.clean(); await vi.advanceTimersByTimeAsync(11);
    expect((await pending).complete).toBe(false); expect(t.storage.remove).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical subject before any adapter call', async () => {
    const t = setup();
    const adapter = createErasureStorageAdapter({ storage: t.storage, manifest: t.manifest });
    await expect(adapter.cleanSubject('../other')).rejects.toThrow();
    expect(t.storage.listPrefix).not.toHaveBeenCalled();
  });
});
