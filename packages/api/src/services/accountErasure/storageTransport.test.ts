/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createErasureStorageTransport } from './storageTransport';
import { createErasureStorageAdapter } from './storage';

const actor = '00000000-0000-4000-8000-000000000001';
const path = (name: string) => `${actor}/${name}.png`;
const scope = () => ({ bucket: 'ticket-attachments' as const, signal: new AbortController().signal });
function setup(names = ['a', 'b', 'c', 'd', 'e']) {
  const objects = new Set(names.map(path));
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    let value: unknown;
    if (String(url).endsWith('/object/list-v2/ticket-attachments')) {
      expect(body).toMatchObject({ limit: 1000, with_delimiter: false });
      expect(body).not.toHaveProperty('cursor');
      expect(body).not.toHaveProperty('offset');
      value = { hasNext: false, nextCursor: null, folders: [],
        objects: [...objects].filter(key => key.startsWith(body.prefix)).reverse().map(key => ({ key, id: key })) };
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
