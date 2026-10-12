/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Off-database erasure manifest (migration 0227). Confirmed deletions are copied, as IDs and
 * the confirmation time only, from the database "pending sync" outbox to the existing Upstash
 * Redis. After an older backup is restored, these keys are replayed before service reopens
 * (docs/runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md). Never throws into deletion paths. */
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { redisEnvironment } from '../redisEnvironment';

/** Must exceed the longest backup or PITR window of the production plan (checked before launch). */
export const ERASURE_MANIFEST_TTL_SECONDS = 35 * 24 * 60 * 60;
export const ERASURE_MANIFEST_KEY_PREFIX = 'graylum:erasure-manifest:';
const BATCH = 100;
const STEP_TIMEOUT_MS = 2000;

type Database = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> };
export type ManifestRedis = { set(key: string, value: string, options: { nx: true; exat: number }): Promise<unknown> };
export type ManifestSyncResult = { ok: boolean; synced: number; pending: number; cleaned: number };

const pendingRows = z.array(z.object({
  id: z.string().uuid(),
  kind: z.enum(['account', 'answer', 'session', 'artifact', 'content', 'library_document']),
  targetId: z.string().uuid(),
  profileId: z.string().uuid(),
  confirmedAt: z.string().min(1),
}).strict()).max(500);
type PendingRow = z.infer<typeof pendingRows>[number];

let cachedRedis: ManifestRedis | null | undefined;
/** Same credentials as the rate limiter. Missing configuration means "cannot sync", not an error. */
export function manifestRedisFromEnv(env: NodeJS.ProcessEnv = process.env): ManifestRedis | null {
  if (cachedRedis !== undefined && env === process.env) return cachedRedis;
  let created: ManifestRedis | null = null;
  try {
    const { url, token } = redisEnvironment(env);
    created = new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(STEP_TIMEOUT_MS) });
  } catch { created = null; }
  if (env === process.env) cachedRedis = created;
  return created;
}

function within<T>(operation: PromiseLike<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(operation),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ERASURE_MANIFEST_TIMEOUT')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function call<T>(database: Database, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const response = await within(database.rpc(name, args));
  if (response.error) throw new Error('ERASURE_MANIFEST_RPC_FAILED');
  return schema.parse(response.data);
}

/** The payload is exactly these four fields: no body, title, filename, email or hash. */
export function manifestEntry(row: PendingRow) {
  const key = `${ERASURE_MANIFEST_KEY_PREFIX}${row.kind}:${row.targetId}`;
  const value = JSON.stringify({ kind: row.kind, targetId: row.targetId, profileId: row.profileId, confirmedAt: row.confirmedAt });
  // EXAT from the confirmation time, with NX, so a later re-sync can never extend the key.
  const exat = Math.floor(Date.parse(row.confirmedAt) / 1000) + ERASURE_MANIFEST_TTL_SECONDS;
  return { key, value, exat };
}

/** Copy pending rows to Redis, then mark them synced. Redis missing or failing leaves rows
 * pending (ok=false) for the next attempt; the daily cron additionally removes 35-day-old rows. */
export async function syncErasureManifest(database: Database, options: {
  redis?: ManifestRedis | null; cleanup?: boolean; deadline?: number; now?: () => number;
} = {}): Promise<ManifestSyncResult> {
  const result: ManifestSyncResult = { ok: true, synced: 0, pending: 0, cleaned: 0 };
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + 10_000;
  const redis = options.redis === undefined ? manifestRedisFromEnv() : options.redis;
  try {
    for (;;) {
      const rows = await call(database, 'erasure_manifest_pending', { n: BATCH }, pendingRows);
      result.pending = rows.length;
      if (!rows.length) break;
      if (!redis) { result.ok = false; break; }
      const done: string[] = [];
      try {
        for (const row of rows) {
          if (now() > deadline) break;
          const entry = manifestEntry(row);
          if (!Number.isFinite(entry.exat)) throw new Error('ERASURE_MANIFEST_INVALID_TIME');
          // Already past 35 days: no backup can need it, so nothing is written.
          if (entry.exat > Math.floor(now() / 1000)) {
            await within(redis.set(entry.key, entry.value, { nx: true, exat: entry.exat }));
          }
          done.push(row.id);
        }
      } catch { result.ok = false; }
      if (done.length) {
        await call(database, 'erasure_manifest_mark_synced', { ids: done }, z.number().int().nonnegative());
        result.synced += done.length;
        result.pending -= done.length;
      }
      if (!result.ok || done.length < rows.length || rows.length < BATCH || now() > deadline) break;
    }
  } catch { result.ok = false; }
  if (options.cleanup) {
    try {
      result.cleaned = await call(database, 'erasure_manifest_cleanup', {}, z.number().int().nonnegative());
    } catch { result.ok = false; }
  }
  if (!result.ok) logger.warn('database', 'erasure_manifest_sync_incomplete', { pending: result.pending });
  return result;
}

/** Best effort right after a confirmed deletion. The daily cron is the guaranteed retry, so
 * this never delays, fails or logs identifiers for the user's request. */
export function scheduleErasureManifestSync(database: Database, redis: ManifestRedis | null = manifestRedisFromEnv()) {
  if (!redis) return;
  void within(syncErasureManifest(database, { redis, deadline: Date.now() + 2500 }), 3000)
    .catch(() => logger.warn('database', 'erasure_manifest_sync_incomplete'));
}
