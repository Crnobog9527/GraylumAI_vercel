/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { erasurePrefixCursor, isCanonicalErasureAttachment, type ErasureStorageTransport } from './storage';

type Client = Pick<SupabaseClient, 'storage'>;
const bucket = 'ticket-attachments';
const pageSize = 1000;
const maxPages = 10;
const maxObjects = 5000;
const readTimeoutMs = 2000;
const listing = z.object({
  hasNext: z.boolean(), nextCursor: z.string().max(4096).nullish(),
  folders: z.array(z.unknown()), objects: z.array(z.object({ key: z.string().optional(), name: z.string().optional(), id: z.string().min(1) })),
});
const failure = () => new Error('ERASURE_STORAGE_UNKNOWN');
function objectKey(row: { key?: string; name?: string }, prefix: string): string {
  const named = row.name === undefined ? undefined : row.name.includes('/') ? row.name
    : prefix.slice(0, prefix.lastIndexOf('/') + 1) + row.name;
  const key = row.key ?? named;
  if (!key || !isCanonicalErasureAttachment(key) || !key.startsWith(prefix)
    || named !== undefined && named !== key) throw failure();
  return key;
}

function check(target: string, signal: AbortSignal) {
  if (target !== bucket || signal.aborted) throw failure();
}

/** Production uses the original listV2 continuation with name ordering. Each page is
 * checkpointed only after classification and deletion observation. Exact absence reads
 * and legacy inventories remain complete bounded reads. Quiescence is owned by the host. */
export function createErasureStorageTransport(client: Client, options: { boundedPrefix?: boolean } = {}): ErasureStorageTransport {
  const collect = async (prefix: string, signal: AbortSignal) => {
    const paths = new Set<string>();
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    const started = Date.now();
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() - started >= readTimeoutMs) throw failure();
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
      for (const object of parsed.data.objects) {
        const row = { ...object, key: objectKey(object, prefix) };
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
        || afterPath !== null && (!afterPath.startsWith(prefix) || !isCanonicalErasureAttachment(erasurePrefixCursor(afterPath).path))) {
        throw failure();
      }
      if (options.boundedPrefix) {
        const previous = afterPath === null ? null : erasurePrefixCursor(afterPath);
        if (previous && !previous.cursor) throw failure();
        const result = await client.storage.from(bucket).listV2({
          prefix, limit, with_delimiter: false, sortBy: { column: 'name', order: 'asc' },
          ...(previous ? { cursor: previous.cursor } : {}),
        }, { signal, cache: 'no-store' });
        check(target, signal);
        if (result.error) throw failure();
        const data = listing.parse(result.data);
        const paths = data.objects.map(row => objectKey(row, prefix));
        if (data.folders.length || paths.length > limit || new Set(data.objects.map(row => row.id)).size !== paths.length
          || paths.some((path, index) => !path.startsWith(prefix) || !isCanonicalErasureAttachment(path)
            || index > 0 && path <= paths[index - 1] || previous !== null && path <= previous.path)
          || data.hasNext && (!paths.length || !data.nextCursor || data.nextCursor === previous?.cursor)
          || !data.hasNext && data.nextCursor) throw failure();
        return { paths, nextAfterPath: data.hasNext ? `${paths.at(-1)}|${encodeURIComponent(data.nextCursor!)}` : null };
      }
      const selected = await read(prefix, signal);
      const all = selected.filter(path => afterPath === null || path > afterPath);
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
