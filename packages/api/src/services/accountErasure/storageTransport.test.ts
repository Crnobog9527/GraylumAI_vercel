/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErasureStorageTransport } from './storageTransport';
import { createErasureStorageAdapter } from './storage';

const actor = '00000000-0000-4000-8000-000000000001';
const path = (name: string) => `${actor}/${name}.png`;
const scope = () => ({ bucket: 'ticket-attachments' as const, signal: new AbortController().signal });
function setup(names = ['a', 'b', 'c', 'd', 'e'], remotePageSize = 1000) {
  const objects = new Set(names.map(path));
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    let value: unknown;
    if (String(url).endsWith('/object/list-v2/ticket-attachments')) {
      expect(body).toMatchObject({ limit: 1000, with_delimiter: false });
      expect(body).not.toHaveProperty('offset');
      const all = [...objects].filter(key => key.startsWith(body.prefix)).sort();
      // Synthetic server cursor: the client must pass it verbatim, never interpret it.
      const start = body.cursor ? Number(body.cursor.slice('opaque:'.length)) : 0;
      const end = Math.min(start + remotePageSize, all.length);
      value = { hasNext: end < all.length, nextCursor: end < all.length ? `opaque:${end}` : null, folders: [],
        objects: all.slice(start, end).map(key => ({ key, id: key })) };
    } else {
      expect(String(url)).toBe('https://erasure.invalid/storage/v1/object/ticket-attachments');
      expect(init?.method).toBe('DELETE');
      for (const key of body.prefixes) objects.delete(key);
      value = [];
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = createClient('https://erasure.invalid', 'synthetic-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { fetcher, objects, transport: createErasureStorageTransport(client) };
}

afterEach(() => vi.useRealTimers());

describe('bounded Storage SDK transport', () => {
  it('actual SDK plus core cleans logical pages without deletion/offset skips', async () => {
    const f = setup();
    const adapter = createErasureStorageAdapter({ storage: f.transport, limits: { pageSize: 2 }, manifest: {
      async list() { return { items: [], nextCursor: null }; },
      async classify({ paths }) { return paths.map(key => ({ path: key, state: 'unreferenced' })); },
    } });
    expect(await adapter.cleanSubject(actor)).toEqual({ complete: true, remaining: 0, manualReview: 0 });
    expect(f.objects.size).toBe(0);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(3);
  });
  it.each([
    { hasNext: true, nextCursor: 'opaque', folders: [], objects: [] },
    { hasNext: false, nextCursor: 'contradiction', folders: [], objects: [] },
    { hasNext: false, folders: [{}], objects: [] },
    { hasNext: false, folders: [], objects: [{ name: path('a'), id: 'id' }] },
    { hasNext: false, folders: [], objects: [{ key: `${actor}/nested/a.png`, id: 'id' }] },
    { hasNext: false, folders: [], objects: [{ key: path('a'), id: '1' }, { key: path('a'), id: '2' }] },
    { hasNext: false, folders: [], objects: Array.from({ length: 1001 }, (_, i) => ({ key: path(String(i)), id: String(i) })) },
    {},
  ])('refuses incomplete or unsupported listing before deletion %#', async (value) => {
    const f = setup();
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify(value)));
    await expect(f.transport.listPrefix({ ...scope(), prefix: `${actor}/`, afterPath: null, limit: 2 })).rejects.toThrow();
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('unknown');
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
  });
  it('reports exact presence and absence, without confusing similarly named keys', async () => {
    const f = setup(['a', 'a.png.extra']);
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('present');
    await f.transport.remove({ ...scope(), paths: [path('a')] });
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('absent');
    expect(f.objects.has(path('a.png.extra'))).toBe(true);
  });
  it.each([400, 401, 403, 404, 500])('never equates failed listing %i to absence', async (status) => {
    const f = setup();
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ message: 'synthetic failure' }), { status }));
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('unknown');
  });
  it('does not repeat remove after transport error; next read can establish actual absence', async () => {
    const f = setup();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (init?.method === 'DELETE') throw new Error('synthetic uncertainty');
      return result;
    });
    await expect(f.transport.remove({ ...scope(), paths: [path('a')] })).rejects.toThrow();
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('absent');
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it('rejects wrong bucket, traversal, malformed cursor and pre-aborted work without I/O', async () => {
    const f = setup();
    await expect(f.transport.listPrefix({ ...scope(), prefix: `${actor}/`, afterPath: '../x', limit: 2 })).rejects.toThrow();
    await expect(f.transport.remove({ ...scope(), bucket: 'wrong' as never, paths: [path('a')] })).rejects.toThrow();
    await expect(f.transport.remove({ ...scope(), paths: [`${actor}/../x`] })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    expect(await f.transport.getState({ ...scope(), signal: controller.signal, path: path('a') })).toBe('unknown');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

const names = (n: number) => Array.from({ length: n }, (_, i) => `n${String(i).padStart(5, '0')}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (keys: string[], cursor: string | null) => ({
  hasNext: cursor !== null, nextCursor: cursor, folders: [], objects: keys.map(key => ({ key, id: key })),
});
const prefixInput = () => ({ ...scope(), prefix: `${actor}/`, afterPath: null, limit: 100 });

describe('complete bounded remote enumeration before returning candidates', () => {
  it('collects over 1000 objects before returning a local page; restarts after deletion shrinks remote pages', async () => {
    const f = setup(names(1105));
    const first = await f.transport.listPrefix(prefixInput());
    expect(first).toEqual({ paths: names(100).map(path), nextAfterPath: path('n00099') });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body)).cursor).toBe('opaque:1000');
    await f.transport.remove({ ...scope(), paths: names(100).map(path) });
    const start = f.fetcher.mock.calls.length;
    expect(await f.transport.listPrefix({ ...prefixInput(), afterPath: path('n00099') })).toEqual({
      paths: names(200).slice(100).map(path), nextAfterPath: path('n00199'),
    });
    expect(JSON.parse(String(f.fetcher.mock.calls[start][1]?.body))).not.toHaveProperty('cursor');
    expect(f.fetcher.mock.calls.slice(start)).toHaveLength(2);
  });
  it.each([403, 500])('page two status %i cannot expose partial candidates or cause deletion', async (status) => {
    const f = setup(names(1105));
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (JSON.parse(String(init?.body)).cursor) return json({ message: 'synthetic failure' }, status);
      return original(url, init);
    });
    const adapter = createErasureStorageAdapter({ storage: f.transport, manifest: {
      async list() { return { items: [], nextCursor: null }; },
      async classify() { throw new Error('must not classify a partial enumeration'); },
    } });
    expect(await adapter.cleanSubject(actor)).toMatchObject({ complete: false, remaining: 1 });
    expect(f.objects.size).toBe(1105);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
  });
  it.each(['duplicate-key', 'duplicate-id', 'loop', 'missing', 'oversized', 'empty-next', 'malformed'])
  ('rejects cross-page corruption: %s', async (mode) => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(json(page([path('a')], 'first')));
    let second: unknown = page([path('b')], null);
    if (mode === 'duplicate-key') second = page([path('a')], null);
    if (mode === 'duplicate-id') second = { ...page([path('b')], null), objects: [{ key: path('b'), id: path('a') }] };
    if (mode === 'loop') second = page([path('b')], 'first');
    if (mode === 'missing') second = { ...page([path('b')], null), hasNext: true };
    if (mode === 'oversized') second = page([path('b')], 'x'.repeat(4097));
    if (mode === 'empty-next') second = page([], 'next');
    if (mode === 'malformed') second = { hasNext: false };
    f.fetcher.mockResolvedValueOnce(json(second));
    await expect(f.transport.listPrefix(prefixInput())).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('caps page count and object count; a later read starts fresh after each rejection', async () => {
    for (const [count, size, requests] of [[11, 1, 10], [5001, 1000, 6]]) {
      const f = setup(names(count), size);
      await expect(f.transport.listPrefix(prefixInput())).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(requests);
      f.objects.clear();
      const start = f.fetcher.mock.calls.length;
      expect(await f.transport.listPrefix(prefixInput())).toEqual({ paths: [], nextAfterPath: null });
      expect(JSON.parse(String(f.fetcher.mock.calls[start][1]?.body))).not.toHaveProperty('cursor');
    }
  });
  it.each(['abort', 'timeout'])('bounds a stuck second page even if injected transport ignores %s', async (mode) => {
    vi.useFakeTimers();
    const f = setup();
    let finish!: (result: Response) => void;
    f.fetcher.mockResolvedValueOnce(json(page([path('a')], 'first')))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = f.transport.getState({ ...scope(), signal: controller.signal, path: path('a') });
    for (let i = 0; i < 20 && f.fetcher.mock.calls.length < 2; i++) await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    if (mode === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toBe('unknown');
    finish(json(page([path('a.png.extra')], 'late')));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(await f.transport.getState({ ...scope(), path: path('a') })).toBe('present');
    expect(JSON.parse(String(f.fetcher.mock.calls[2][1]?.body))).not.toHaveProperty('cursor');
  });
  it('core budget exit stays incomplete and the next invocation re-enumerates remaining objects', async () => {
    const f = setup(names(1105));
    const adapter = createErasureStorageAdapter({ storage: f.transport, limits: { pageSize: 100, maxObjects: 100 }, manifest: {
      async list() { return { items: [], nextCursor: null }; },
      async classify({ paths }) { return paths.map(key => ({ path: key, state: 'unreferenced' })); },
    } });
    expect(await adapter.cleanSubject(actor)).toMatchObject({ complete: false, remaining: 1 });
    expect(f.objects.size).toBe(1005);
    const start = f.fetcher.mock.calls.length;
    expect(await adapter.cleanSubject(actor)).toMatchObject({ complete: false, remaining: 1 });
    expect(f.objects.size).toBe(905);
    expect(JSON.parse(String(f.fetcher.mock.calls[start][1]?.body))).not.toHaveProperty('cursor');
  });
});
