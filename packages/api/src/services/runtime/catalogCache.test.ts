/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { catalogRead, catalogVersion, clearCatalogCache, observeCatalog, withCatalogRequest } from './catalogCache';

type Snapshot = { enabled: boolean; settings: number; models: number; skills: number };
function client(state: { snapshot: Snapshot | null; error?: { code: string } }) {
  const rpc = vi.fn(async (name: string) => {
    expect(name).toBe('catalog_versions_snapshot');
    return state.error ? { data: null, error: state.error } : { data: state.snapshot, error: null };
  });
  return { rpc } as unknown as Pick<SupabaseClient, 'rpc'> & { rpc: typeof rpc };
}
const ok = (value: unknown) => vi.fn(async () => ({ data: value, error: null }));
afterEach(() => { clearCatalogCache(); vi.useRealTimers(); });

describe('catalogCache (DB-RW PR-B)', () => {
  it('reads the versions once per request and reuses a value while its catalog is unchanged', async () => {
    const state = { snapshot: { enabled: true, settings: 1, models: 1, skills: 1 } }, admin = client(state);
    const load = ok({ key: 'x', value: 1 });
    const first = await withCatalogRequest(async () => {
      const a = await catalogRead(admin, 'settings', 'k', load);
      const b = await catalogRead(admin, 'settings', 'k', load);
      return [a, b];
    });
    expect(first).toEqual([{ data: { key: 'x', value: 1 }, error: null }, { data: { key: 'x', value: 1 }, error: null }]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    // The next request sees the same version: no read of the catalog itself.
    await withCatalogRequest(() => catalogRead(admin, 'settings', 'k', load));
    expect(load).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    // Another catalog changed: this one is still reused. Its own change makes the next request read again.
    state.snapshot = { ...state.snapshot, models: 2 };
    await withCatalogRequest(() => catalogRead(admin, 'settings', 'k', load));
    expect(load).toHaveBeenCalledTimes(1);
    state.snapshot = { ...state.snapshot, settings: 2 };
    await withCatalogRequest(() => catalogRead(admin, 'settings', 'k', load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('hands out copies, so a caller cannot change what the next request gets', async () => {
    const admin = client({ snapshot: { enabled: true, settings: 1, models: 1, skills: 1 } });
    const load = ok({ list: [1] });
    await withCatalogRequest(async () => { ((await catalogRead(admin, 'models', 'k', load)).data as { list: number[] }).list.push(2); });
    expect((await withCatalogRequest(() => catalogRead(admin, 'models', 'k', load))).data).toEqual({ list: [1] });
  });

  it('never keeps a failed read', async () => {
    const admin = client({ snapshot: { enabled: true, settings: 1, models: 1, skills: 1 } });
    const failed = vi.fn(async () => ({ data: null, error: { message: 'down' } }));
    for (let i = 0; i < 2; i++) expect((await withCatalogRequest(() => catalogRead(admin, 'settings', 'k', failed))).error).toBeTruthy();
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('reads fresh outside a request, while off, for a client that may not read the versions, and when unreadable', async () => {
    const load = ok(1);
    const on = client({ snapshot: { enabled: true, settings: 1, models: 1, skills: 1 } });
    await catalogRead(on, 'settings', 'k', load);
    await catalogRead(on, 'settings', 'k', load);
    expect(on.rpc).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);

    // A user-scoped client is refused the snapshot (service role only): it always reads fresh, never another client's rows.
    await withCatalogRequest(() => catalogRead(on, 'settings', 'k', load));
    const user = client({ snapshot: null, error: { code: '42501' } });
    for (let i = 0; i < 2; i++) await withCatalogRequest(() => catalogRead(user, 'settings', 'k', load));
    expect(load).toHaveBeenCalledTimes(5);
    expect(user.rpc).toHaveBeenCalledTimes(2);

    // Off: the switch is asked again only after a minute; meanwhile every read is fresh and nothing is kept.
    vi.useFakeTimers({ now: Date.parse('2026-10-27T00:00:00Z') });
    clearCatalogCache();
    const off = client({ snapshot: { enabled: false, settings: 1, models: 1, skills: 1 } });
    for (let i = 0; i < 3; i++) await withCatalogRequest(() => catalogRead(off, 'settings', 'k', load));
    expect(off.rpc).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(8);
    vi.advanceTimersByTime(60_001);
    await withCatalogRequest(() => catalogRead(off, 'settings', 'k', load));
    expect(off.rpc).toHaveBeenCalledTimes(2);

    // Deployed before the migration: treated as off, not asked on every request.
    clearCatalogCache();
    const missing = client({ snapshot: null, error: { code: 'PGRST202' } });
    for (let i = 0; i < 3; i++) await withCatalogRequest(() => catalogRead(missing, 'settings', 'k', load));
    expect(missing.rpc).toHaveBeenCalledTimes(1);
  });

  it('reads again after a minute even if the version did not move', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-27T00:00:00Z') });
    const admin = client({ snapshot: { enabled: true, settings: 1, models: 1, skills: 1 } }), load = ok(1);
    await withCatalogRequest(() => catalogRead(admin, 'skills', 'k', load));
    vi.advanceTimersByTime(59_000);
    await withCatalogRequest(() => catalogRead(admin, 'skills', 'k', load));
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await withCatalogRequest(() => catalogRead(admin, 'skills', 'k', load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('takes versions a precheck already read, for that client only', async () => {
    const admin = client({ snapshot: null }), other = client({ snapshot: null });
    await withCatalogRequest(async () => {
      observeCatalog(admin, { enabled: true, settings: 3, models: 4, skills: 5 });
      expect(await catalogVersion(admin, 'skills')).toBe(5);
      expect(await catalogVersion(other, 'skills')).toBeUndefined();
    });
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(await catalogVersion(admin, 'skills')).toBeUndefined();
  });
});
