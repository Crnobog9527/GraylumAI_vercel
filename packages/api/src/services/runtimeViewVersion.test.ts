/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const redis = vi.hoisted(() => ({ fail: false }));
vi.mock('../lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('./redisRateLimiter', () => ({
  getRedis: () => ({
    mget: async (...keys: string[]) => { if (redis.fail) throw new Error('down'); return keys.map(k => store.get(k) ?? null); },
    pipeline: () => {
      const ops: Array<() => void> = [];
      const p = {
        set: (k: string, v: string, o?: { nx?: boolean }) => { ops.push(() => { if (!(o?.nx && store.has(k))) store.set(k, v); }); return p; },
        exec: async () => { if (redis.fail) throw new Error('down'); ops.forEach(f => f()); return []; },
      };
      return p;
    },
  }),
}));
import { READ_ONLY_RPCS, VIEW_VERSION_GLOBAL_KEY, readViewTokens, viewVersionActorKey, viewWriteTarget, withViewVersionBump } from './runtimeViewVersion';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const base = 'https://x.supabase.co/rest/v1/';
const post = (path: string, body: unknown, method = 'POST') => viewWriteTarget(base + path, { method, body: JSON.stringify(body) });
beforeEach(() => { store.clear(); redis.fail = false; });

describe('viewWriteTarget', () => {
  it('reads never bump', () => {
    expect(viewWriteTarget(base + 'profiles?select=id', { method: 'GET' })).toBeNull();
    expect(viewWriteTarget('https://x.supabase.co/auth/v1/user', { method: 'GET' })).toBeNull();
    for (const name of READ_ONLY_RPCS) expect(post('rpc/' + name, { p_actor_id: A })).toBeNull();
  });
  it('every other rpc bumps the actors it names', () => {
    expect(post('rpc/runtime_execution', { p_actor_id: A, p_execution_id: B })).toEqual([A]);
    expect(post('rpc/bill2_record', { a: A })).toEqual([A]);
    expect(post('rpc/runtime_library_propagate', { p_actor_id: A, p_other_user: B })).toEqual([A, B]);
  });
  it('a write naming nobody bumps everyone', () => {
    expect(post('rpc/runtime_stale_charged_rounds', {})).toBe('global');
    expect(post('rpc/anything_new', { p_limit: 5 })).toBe('global');
    expect(viewWriteTarget(base + 'rpc/x', { method: 'POST' })).toBe('global');
  });
  it('table writes: body rows and query filters', () => {
    expect(post('library_documents', [{ actor_id: A }, { actor_id: B }])).toEqual([A, B]);
    expect(viewWriteTarget(base + `library_documents?actor_id=eq.${A}`, { method: 'PATCH', body: '{"deleted_at":"now"}' })).toEqual([A]);
    expect(viewWriteTarget(base + 'system_settings?key=eq.x', { method: 'PATCH', body: '{}' })).toBe('global');
    expect(viewWriteTarget(base + `profiles?id=eq.${A}`, { method: 'DELETE' })).toBe('global');
  });
});

describe('tokens and the fetch wrapper', () => {
  it('creates tokens once and returns the same value until a write replaces it', async () => {
    const first = await readViewTokens(A);
    expect(await readViewTokens(A)).toEqual(first);
    expect(await readViewTokens(B)).toMatchObject({ global: first!.global });
    const transport = vi.fn(async () => new Response('{}'));
    await withViewVersionBump(transport as unknown as typeof fetch)(base + 'rpc/bill2_record', { method: 'POST', body: JSON.stringify({ a: A }) });
    const next = await readViewTokens(A);
    expect(next!.actor).not.toBe(first!.actor);
    expect(next!.global).toBe(first!.global);
    expect((await readViewTokens(B))!.actor).not.toBe(next!.actor);
  });
  it('a global write replaces the shared token only', async () => {
    const first = await readViewTokens(A);
    await withViewVersionBump((async () => new Response('{}')) as typeof fetch)(base + 'rpc/x', { method: 'POST', body: '{}' });
    const next = await readViewTokens(A);
    expect(next!.global).not.toBe(first!.global);
    expect(next!.actor).toBe(first!.actor);
  });
  it('bumps after a failed write too, and does not bump for reads', async () => {
    const first = await readViewTokens(A);
    const read = vi.fn(async () => new Response('{}'));
    await withViewVersionBump(read as unknown as typeof fetch)(base + 'rpc/runtime_view', { method: 'POST', body: JSON.stringify({ p_actor_id: A }) });
    expect(await readViewTokens(A)).toEqual(first);
    const broken = vi.fn(async () => { throw new Error('lost response'); });
    await expect(withViewVersionBump(broken as unknown as typeof fetch)(base + 'rpc/bill2_record', { method: 'POST', body: JSON.stringify({ a: A }) })).rejects.toThrow('lost response');
    expect((await readViewTokens(A))!.actor).not.toBe(first!.actor);
  });
  it('Redis down: tokens are null and a write still goes through', async () => {
    redis.fail = true;
    expect(await readViewTokens(A)).toBeNull();
    const response = await withViewVersionBump((async () => new Response('ok')) as typeof fetch)(base + 'rpc/bill2_record', { method: 'POST', body: JSON.stringify({ a: A }) });
    expect(await response.text()).toBe('ok');
    expect(store.has(viewVersionActorKey(A))).toBe(false);
    expect(store.has(VIEW_VERSION_GLOBAL_KEY)).toBe(false);
  });
});
