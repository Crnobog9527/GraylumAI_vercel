/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const tokens = vi.hoisted(() => ({ value: { actor: 'a1', global: 'g1' } as { actor: string; global: string } | null }));
vi.mock('../runtimeViewVersion', () => ({ readViewTokens: async () => (tokens.value ? { ...tokens.value } : null) }));
import { clearViewCache, readNativeRuntimeViewWithWorkItems, VIEW_CACHE_MS } from './nativeView';

const actor = '10000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000002';
let activeExecution: string | null = null;
let accessError: { message: string } | null = null;
let body = 'first';
function db() {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'runtime_view_access') return accessError ? { data: null, error: accessError } : { data: { sessionId: session, activeExecution }, error: null };
    if (name === 'runtime_view_with_work_items') {
      return { data: { view: { sessionId: session, activeExecution, executions: [{ executionId: 'e1', state: 'completed', body }] }, workItems: {} }, error: null };
    }
    throw new Error('unexpected ' + name);
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}
const names = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.map(call => call[0]);
beforeEach(() => { clearViewCache(); tokens.value = { actor: 'a1', global: 'g1' }; activeExecution = null; accessError = null; body = 'first'; vi.useRealTimers(); });

describe('refresh of an idle, unchanged conversation', () => {
  it('first read hits the database, the next one only asks the access check (1 round trip instead of the full read)', async () => {
    const { client, rpc } = db();
    const one = await readNativeRuntimeViewWithWorkItems(client, actor, session);
    const two = await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(two).toEqual(one);
    expect(names(rpc)).toEqual(['runtime_view_with_work_items', 'runtime_view_access']);
  });
  it('a changed user token or shared token reads the database again and shows the new content', async () => {
    const { client, rpc } = db();
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    body = 'second';
    tokens.value = { actor: 'a2', global: 'g1' };
    expect(JSON.stringify(await readNativeRuntimeViewWithWorkItems(client, actor, session))).toContain('second');
    body = 'third';
    tokens.value = { actor: 'a2', global: 'g2' };
    expect(JSON.stringify(await readNativeRuntimeViewWithWorkItems(client, actor, session))).toContain('third');
    expect(names(rpc)).toEqual(Array(3).fill('runtime_view_with_work_items'));
  });
  it('permission is checked every time: a refused access reads (and raises) through the full path', async () => {
    const { client, rpc } = db();
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    accessError = { message: 'RUNTIME_SCOPE_DENIED' };
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(names(rpc)).toEqual(['runtime_view_with_work_items', 'runtime_view_access', 'runtime_view_with_work_items']);
  });
  it('a session with an active execution is never cached or served from the cache', async () => {
    const { client, rpc } = db();
    activeExecution = 'e1';
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(names(rpc)).toEqual(Array(2).fill('runtime_view_with_work_items'));
    activeExecution = null;
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    activeExecution = 'e2';
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(names(rpc).slice(2)).toEqual(['runtime_view_with_work_items', 'runtime_view_access', 'runtime_view_with_work_items']);
  });
  it('expires after VIEW_CACHE_MS', async () => {
    vi.useFakeTimers();
    const { client, rpc } = db();
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    vi.advanceTimersByTime(VIEW_CACHE_MS + 1);
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(names(rpc)).toEqual(Array(2).fill('runtime_view_with_work_items'));
  });
  it('Redis unavailable: always the database, nothing cached, no error', async () => {
    tokens.value = null;
    const { client, rpc } = db();
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    tokens.value = { actor: 'a1', global: 'g1' };
    await readNativeRuntimeViewWithWorkItems(client, actor, session);
    expect(names(rpc)).toEqual(Array(2).fill('runtime_view_with_work_items'));
  });
  it('other users and sessions never share an entry; a hit is a copy', async () => {
    const { client, rpc } = db();
    const first = await readNativeRuntimeViewWithWorkItems(client, actor, session);
    await readNativeRuntimeViewWithWorkItems(client, '10000000-0000-4000-8000-0000000000ff', session);
    expect(names(rpc)).toEqual(Array(2).fill('runtime_view_with_work_items'));
    const hit = await readNativeRuntimeViewWithWorkItems(client, actor, session);
    (hit.view.executions[0] as { body: string }).body = 'mutated';
    expect(JSON.stringify(await readNativeRuntimeViewWithWorkItems(client, actor, session))).toContain('first');
    expect(JSON.stringify(first)).toContain('first');
  });
});
