/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/*
 * DB-RW PR-B (db-rw-redesign-v1 section 4): slow-changing, administrator-written catalogs kept in this process's memory.
 * Each catalog has one version number in the database (catalog_versions, raised by triggers on every change). A request
 * reads the three numbers once (catalog_versions_snapshot; later PR-C's precheck returns them) and every cached read in
 * that request is served from memory only while its catalog still has the version it was read under; otherwise it reads
 * again. A failed read is never kept, so it never becomes a default.
 * Only these catalogs: system settings, model rows, Skill catalog rows. Never balances, grants, tombstones, Session state,
 * a user's membership or anything a user writes. Outside a request scope (cron, scripts, tests that do not opt in), or
 * while system_settings runtime_rw_v2.catalogCache is not true, every read goes to the database as before.
 */
export type CatalogGroup = 'settings' | 'models' | 'skills';
export type CatalogSnapshot = { enabled: boolean; settings: number; models: number; skills: number };
type Read<T> = { data: T; error: unknown };

const snapshotSchema = z.object({ enabled: z.boolean(), settings: z.number().int().positive(),
  models: z.number().int().positive(), skills: z.number().int().positive() });
/** Even an unchanged version is read again after this, in case a change ever bypassed the triggers. */
const MAX_AGE_MS = 60_000;
/** While the switch is off, the snapshot itself is reread at most this often, so an off switch costs about nothing. */
const OFF_RECHECK_MS = 60_000;
const MAX_ENTRIES = 512;

type Client = Pick<SupabaseClient, 'rpc'>;
// Per client: only the service role may run catalog_versions_snapshot, so a user-scoped (RLS) client always gets null and
// reads fresh. Rows kept here were read by the service role and are only ever handed back to a service-role read.
type Request = { snapshots: WeakMap<Client, Promise<CatalogSnapshot | null>>; observed?: CatalogSnapshot };
const requests = new AsyncLocalStorage<Request>();
const entries = new Map<string, { group: CatalogGroup; version: number; at: number; value: unknown }>();
let offUntil = 0;

/** The HTTP owner starts one scope per request; a streamed reply keeps it. Nothing in the scope outlives the request. */
export function withCatalogRequest<T>(work: () => T): T {
  return requests.run({ snapshots: new WeakMap() }, work);
}

/** PR-C: the service-role admission precheck already read the versions; that client then needs no read of its own. */
export function observeCatalog(admin: Client, snapshot: unknown): void {
  const request = requests.getStore(), parsed = snapshotSchema.safeParse(snapshot);
  if (request && parsed.success) request.snapshots.set(admin, Promise.resolve(parsed.data));
}

export function clearCatalogCache(): void { entries.clear(); offUntil = 0; }

// The function is not there yet (code deployed before the migration): treated as off, so it is not asked on every request.
const MISSING_FUNCTION = new Set(['PGRST202', '42883']);
async function readSnapshot(admin: Client): Promise<CatalogSnapshot | null> {
  try {
    const result = await admin.rpc('catalog_versions_snapshot', {});
    if (result.error && MISSING_FUNCTION.has(String(result.error.code))) return { enabled: false, settings: 1, models: 1, skills: 1 };
    const parsed = snapshotSchema.safeParse(result.error ? null : result.data);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** This request's versions, read at most once per request; null (read fresh) outside a scope, when off or unreadable. */
async function requestSnapshot(admin: Client, now: number): Promise<CatalogSnapshot | null> {
  const request = requests.getStore();
  if (!request) return null;
  let pending = request.snapshots.get(admin);
  if (!pending) {
    if (now < offUntil) return null;
    pending = readSnapshot(admin).then(snapshot => {
      if (snapshot && !snapshot.enabled) { offUntil = Date.now() + OFF_RECHECK_MS; entries.clear(); }
      return snapshot;
    });
    request.snapshots.set(admin, pending);
  }
  const snapshot = await pending;
  return snapshot?.enabled ? snapshot : null;
}

/**
 * `load` is the exact database read; its `{data, error}` is returned unchanged. Within a request scope and with the switch
 * on, a successful result is kept under `key` and the version this request read before loading, and is reused (as a copy)
 * by any later request that sees the same version. A change of the catalog after the versions were read only makes the
 * next request read again: the kept value is never older than the version it is kept under.
 */
export async function catalogRead<R extends Read<unknown>>(admin: Client, group: CatalogGroup, key: string,
  load: () => PromiseLike<R>): Promise<R> {
  const now = Date.now(), snapshot = await requestSnapshot(admin, now);
  if (!snapshot) return load();
  const id = group + '\u0000' + key, version = snapshot[group], hit = entries.get(id);
  // Callers read only data and error, exactly as a successful database read returns them.
  if (hit && hit.version === version && now - hit.at < MAX_AGE_MS) return { data: structuredClone(hit.value), error: null } as R;
  const result = await load();
  if (!result.error) {
    entries.delete(id);
    entries.set(id, { group, version, at: now, value: structuredClone(result.data) });
    for (const oldest of entries.keys()) { if (entries.size <= MAX_ENTRIES) break; entries.delete(oldest); }
  }
  return result;
}

/** The version of `group` this request sees, when the cache is on. */
export async function catalogVersion(admin: Client, group: CatalogGroup): Promise<number | undefined> {
  return (await requestSnapshot(admin, Date.now()))?.[group];
}
