/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCanonicalErasureAttachment, type ErasureStorageTransport } from './storage';

type Client = Pick<SupabaseClient, 'storage'>;
const bucket = 'ticket-attachments';
const pageSize = 1000;
const maxPages = 10;
const maxObjects = 5000;
const readTimeoutMs = 2000;
const listing = z.object({
  hasNext: z.boolean(), nextCursor: z.string().max(4096).nullish(),
  folders: z.array(z.unknown()), objects: z.array(z.object({ key: z.string(), id: z.string().min(1) })),
});
const failure = () => new Error('ERASURE_STORAGE_UNKNOWN');
function check(target: string, signal: AbortSignal) {
  if (target !== bucket || signal.aborted) throw failure();
}

/** The pinned SDK passes nextCursor unchanged to listV2's cursor option. Collect every
 * page before exposing candidates: there is no deletion during this transport read.
 * Each subsequent read starts at page one; remote cursors never survive a read/deletion.
 * This is bounded enumeration, NOT a provider snapshot or concurrent-writer exclusion.
 * The host still owns upload/reference quiescence and authoritative classification. */
export function createErasureStorageTransport(client: Client): ErasureStorageTransport {
  const collect = async (prefix: string, signal: AbortSignal) => {
    const paths = new Set<string>();
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      check(bucket, signal);
      const result = await client.storage.from(bucket).listV2({
        prefix, limit: pageSize, with_delimiter: false, sortBy: { column: 'name', order: 'asc' },
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal, cache: 'no-store' });
      check(bucket, signal);
      if (result.error) throw failure();
      const parsed = listing.safeParse(result.data);
      if (!parsed.success || parsed.data.folders.length || parsed.data.objects.length > pageSize
        || paths.size + parsed.data.objects.length > maxObjects) throw failure();
      for (const row of parsed.data.objects) {
        if (!row.key.startsWith(prefix) || !isCanonicalErasureAttachment(row.key)
          || paths.has(row.key) || identities.has(row.id)) throw failure();
        paths.add(row.key);
        identities.add(row.id);
      }
      if (!parsed.data.hasNext) {
        if (parsed.data.nextCursor) throw failure();
        return [...paths].sort();
      }
      const next = parsed.data.nextCursor;
      if (!parsed.data.objects.length || !next || cursors.has(next)) throw failure();
      cursors.add(next);
      cursor = next;
    }
    throw failure();
  };
  const read = async (prefix: string, signal: AbortSignal) => {
    check(bucket, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, readTimeoutMs);
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
    });
    try {
      // Also bound a transport that ignores abort. A late response cannot advance a page.
      return await Promise.race([collect(prefix, controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  };
  return {
    async listPrefix({ bucket: target, prefix, afterPath, limit, signal }) {
      check(target, signal);
      if (!prefix.endsWith('/') || !isCanonicalErasureAttachment(`${prefix}probe`)
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || afterPath !== null && (!afterPath.startsWith(prefix) || !isCanonicalErasureAttachment(afterPath))) {
        throw failure();
      }
      const all = (await read(prefix, signal)).filter(path => afterPath === null || path > afterPath);
      const paths = all.slice(0, limit);
      return { paths, nextAfterPath: all.length > paths.length ? paths[paths.length - 1] : null };
    },
    async getState({ bucket: target, path, signal }) {
      try {
        check(target, signal);
        if (!isCanonicalErasureAttachment(path)) return 'unknown';
        // A successful complete prefix listing proves absence of this exact key, even
        // when similarly named keys exist. An SDK exists() false may also mean HTTP 400.
        return (await read(path, signal)).includes(path) ? 'present' : 'absent';
      } catch { return 'unknown'; }
    },
    async remove({ bucket: target, paths, signal }) {
      check(target, signal);
      if (!paths.length || paths.length > 100 || new Set(paths).size !== paths.length
        || paths.some(path => !isCanonicalErasureAttachment(path))) throw failure();
      // SDK remove has no AbortSignal parameter. An outer timeout is uncertain and must
      // be resolved by reading the original paths; no retry is implemented here.
      const result = await client.storage.from(bucket).remove(paths);
      check(target, signal);
      if (result.error) throw failure();
      return result.data;
    },
  };
}
