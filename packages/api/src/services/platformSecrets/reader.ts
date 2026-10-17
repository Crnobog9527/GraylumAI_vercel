/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { PLATFORM_SECRET_ENV_FALLBACK, type PlatformSecretSlot } from './slots';

export const PLATFORM_SECRET_CACHE_MS = 60_000;
export const PLATFORM_SECRET_READ_TIMEOUT_MS = 1_000;

export type PlatformSecretErrorCode = 'PLATFORM_SECRET_NOT_CONFIGURED' | 'PLATFORM_SECRET_UNAVAILABLE';
export class PlatformSecretError extends Error {
  constructor(readonly code: PlatformSecretErrorCode, readonly slot: PlatformSecretSlot) {
    super(code);
    this.name = 'PlatformSecretError';
  }
}

export interface PlatformSecret {
  value: string;
  source: 'admin' | 'env';
}
export interface PlatformSecretDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
  /** Read the database now, ignoring and not touching the per-instance cache. For paths that authorize a paid
   * call, so a cleared or replaced key stops working on every instance at once, not after the cache expires. */
  fresh?: boolean;
}
type RpcClient = Pick<SupabaseClient, 'rpc'>;

// Per server instance. Only successful reads are cached ("not filled" included); a failed read is
// never cached and never served from an expired entry.
const cache = new Map<PlatformSecretSlot, { value: string | null; at: number }>();
const inflight = new Map<PlatformSecretSlot, Promise<string | null>>();
// Bumped on every invalidation: a read that started earlier may still finish later, and must not
// put the value it saw (possibly the retired key) back into the cache.
const generation = new Map<PlatformSecretSlot, number>();

/** Drops this instance's cached value, e.g. right after the admin saved or cleared the slot. Reads
 * already in flight still answer their own callers but cannot repopulate the cache; the next caller
 * starts a fresh read. */
export function invalidatePlatformSecret(slot: PlatformSecretSlot) {
  generation.set(slot, (generation.get(slot) ?? 0) + 1);
  cache.delete(slot);
  inflight.delete(slot);
}

export function resetPlatformSecretCacheForTests() {
  cache.clear();
  inflight.clear();
  generation.clear();
}

async function readStored(admin: RpcClient, slot: PlatformSecretSlot, timeoutMs: number): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc('platform_secret_read', { p_slot: slot })
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) throw new Error(error.code ?? 'rpc');
    if (data === null) return null;
    if (typeof data !== 'string' || data.length === 0) throw new Error('shape');
    return data;
  } catch (error) {
    // Codes only: the message of a failed read can never contain the value, but keep logs minimal.
    logger.error('security', 'platform_secret_read_failed', {
      slot, reason: error instanceof Error ? error.message.slice(0, 40) : 'unknown' });
    throw new PlatformSecretError('PLATFORM_SECRET_UNAVAILABLE', slot);
  }
}

/** The admin-stored value (null when not filled), cached for PLATFORM_SECRET_CACHE_MS. */
async function storedValue(admin: RpcClient, slot: PlatformSecretSlot, deps: PlatformSecretDeps) {
  if (deps.fresh) return readStored(admin, slot, deps.timeoutMs ?? PLATFORM_SECRET_READ_TIMEOUT_MS);
  const now = deps.now ?? Date.now;
  const hit = cache.get(slot);
  if (hit && now() - hit.at < PLATFORM_SECRET_CACHE_MS) return hit.value;
  let pending = inflight.get(slot);
  if (!pending) {
    const started = generation.get(slot) ?? 0;
    const read: Promise<string | null> = readStored(admin, slot, deps.timeoutMs ?? PLATFORM_SECRET_READ_TIMEOUT_MS)
      .then(value => {
        if ((generation.get(slot) ?? 0) === started) cache.set(slot, { value, at: now() });
        return value;
      })
      .finally(() => { if (inflight.get(slot) === read) inflight.delete(slot); });
    pending = read;
    inflight.set(slot, read);
  }
  return pending;
}

/**
 * The key a server-side caller should use. Admin value first; during the transition, an allowed
 * environment variable when the admin has not filled the slot. A database failure is an error,
 * never a silent switch to another key. The value must not be logged, returned or persisted.
 */
export async function getPlatformSecret(admin: RpcClient, slot: PlatformSecretSlot,
  deps: PlatformSecretDeps = {}): Promise<PlatformSecret> {
  const stored = await storedValue(admin, slot, deps);
  if (stored) return { value: stored, source: 'admin' };
  const fromEnv = envFallbackValue(slot, deps.env ?? process.env);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  throw new PlatformSecretError('PLATFORM_SECRET_NOT_CONFIGURED', slot);
}

export function envFallbackValue(slot: PlatformSecretSlot, env: Record<string, string | undefined>) {
  const name = PLATFORM_SECRET_ENV_FALLBACK[slot];
  return name ? env[name]?.trim() || null : null;
}
