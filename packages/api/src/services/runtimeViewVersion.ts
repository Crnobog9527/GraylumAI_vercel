/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * DB-100 C5: a version token per user (and one shared by everyone) in Redis, so a conversation refresh can tell
 * "nothing this user can see has been written since my last read" without reading the conversation again.
 *
 * Writers never have to remember to bump: withViewVersionBump wraps the database fetch of every server client, and
 * after any request that may write (every RPC except the read-only list below, every table write) it replaces the
 * token of each user named in the request (p_actor_id, user_id, ...), or the shared token when it names nobody.
 * A token is a random value, never a counter, so an expired or evicted key can never come back with an old value.
 *
 * The bump runs after the write has committed (its response is back, or it failed or timed out and may still have
 * committed), and a reader takes its tokens before it reads. So a read that missed a write always sees a newer token
 * next time. Redis failing never fails a write or a read: a failed read of the tokens means "read the database";
 * a failed bump is logged, and cached views also expire on their own (nativeView.ts).
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import { getRedis } from './redisRateLimiter';

const PREFIX = 'graylum:runtime-view:v1:';
export const VIEW_VERSION_GLOBAL_KEY = `${PREFIX}global`;
const TOKEN_TTL_SECONDS = 86_400;
const DEADLINE_MS = 300;

export const viewVersionActorKey = (actorId: string) => `${PREFIX}actor:${actorId}`;

/**
 * RPCs that only read. Nothing else may be added without checking its SQL writes nothing; an RPC missing here only
 * costs a needless bump, an RPC wrongly listed here would leave a cached view stale.
 */
export const READ_ONLY_RPCS: ReadonlySet<string> = new Set([
  'runtime_view', 'runtime_view_with_work_items', 'runtime_work_items', 'runtime_library_sources_gone',
  'runtime_view_access',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Any argument or filter naming a person (the bill2 functions call the actor `a`); an unrecognised name means 'global'.
const ACTOR_ARGUMENT = /^a$|actor|user|profile|owner|target|member|admin|customer/i;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('VIEW_VERSION_TIMEOUT')), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export type ViewTokens = { actor: string; global: string };

/** This user's and the shared token, created when missing; null whenever Redis cannot answer (read the database). */
export async function readViewTokens(actorId: string): Promise<ViewTokens | null> {
  try {
    const redis = getRedis();
    const keys = [viewVersionActorKey(actorId), VIEW_VERSION_GLOBAL_KEY];
    let values = await within(redis.mget<(string | null)[]>(...keys));
    if (values.some(value => typeof value !== 'string')) {
      // NX: a writer's newer token always wins over the one created here.
      const pipeline = redis.pipeline();
      keys.forEach((key, index) => { if (typeof values[index] !== 'string') pipeline.set(key, randomUUID(), { nx: true, ex: TOKEN_TTL_SECONDS }); });
      await within(pipeline.exec());
      values = await within(redis.mget<(string | null)[]>(...keys));
    }
    const [actor, global] = values;
    return typeof actor === 'string' && typeof global === 'string' ? { actor, global } : null;
  } catch {
    return null;
  }
}

/** Replaces the tokens; never throws. */
export async function bumpViewVersion(target: readonly string[] | 'global'): Promise<void> {
  const keys = target === 'global' ? [VIEW_VERSION_GLOBAL_KEY] : [...new Set(target)].map(viewVersionActorKey);
  if (!keys.length) return;
  try {
    const pipeline = getRedis().pipeline();
    for (const key of keys) pipeline.set(key, randomUUID(), { ex: TOKEN_TTL_SECONDS });
    await within(pipeline.exec());
  } catch {
    logger.error('database', 'runtime_view_version_bump_failed', { scope: target === 'global' ? 'global' : 'actor' });
  }
}

/**
 * Whom a database request may change: null when it cannot write (a read, or a read-only RPC), the users it names,
 * or 'global' when it may write and names nobody.
 */
export function viewWriteTarget(input: RequestInfo | URL, init?: RequestInit): string[] | 'global' | null {
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : String(input)); } catch { return null; }
  const at = url.pathname.indexOf('/rest/v1/');
  if (at < 0) return null;
  const path = url.pathname.slice(at + '/rest/v1/'.length);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (path.startsWith('rpc/')) {
    if (READ_ONLY_RPCS.has(decodeURIComponent(path.slice(4)))) return null;
  } else if (!WRITE_METHODS.has(method)) {
    return null;
  }
  const actors = [...actorsIn(init?.body), ...actorsInFilters(url)];
  return actors.length ? [...new Set(actors)] : 'global';
}

function actorsIn(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  // A table insert of several rows is an array; an RPC body is one object.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const actors = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') return [];
    for (const [key, value] of Object.entries(row)) {
      if (ACTOR_ARGUMENT.test(key) && typeof value === 'string' && UUID.test(value)) actors.add(value.toLowerCase());
    }
  }
  return [...actors];
}

/** PATCH and DELETE name their rows in the query string, e.g. `user_id=eq.<uuid>`. */
function actorsInFilters(url: URL): string[] {
  const actors: string[] = [];
  for (const [key, value] of url.searchParams) {
    const id = value.replace(/^eq\./, '');
    if (ACTOR_ARGUMENT.test(key) && UUID.test(id)) actors.push(id.toLowerCase());
  }
  return actors;
}

/** The database fetch of a server client, bumping view versions after every request that may write. */
export function withViewVersionBump(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const target = viewWriteTarget(input, init);
    if (!target) return transport(input, init);
    try {
      return await transport(input, init);
    } finally {
      // Also after an error or a lost response: the write may have committed.
      await bumpViewVersion(target);
    }
  };
}
