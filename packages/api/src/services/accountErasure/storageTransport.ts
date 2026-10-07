/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCanonicalErasureAttachment, type ErasureStorageTransport } from './storage';

type Client = Pick<SupabaseClient, 'storage'>;
const bucket = 'ticket-attachments';
const maximum = 1000;
const listing = z.object({
  hasNext: z.boolean(), nextCursor: z.string().nullish(),
  folders: z.array(z.unknown()), objects: z.array(z.object({ key: z.string(), id: z.string().min(1) })),
});
const failure = () => new Error('ERASURE_STORAGE_UNKNOWN');
function check(target: string, signal: AbortSignal) {
  if (target !== bucket || signal.aborted) throw failure();
}

/** SDK listV2 has an opaque cursor; it does not promise the core's path cursor semantics.
 * Each read therefore starts a fresh, bounded, complete listing. hasNext is refused before
 * returning any candidates. Only this complete set is paginated locally by ASCII path.
 * No offset or remote cursor is reused after deletion. Large prefixes remain pending.
 * The host still owns upload/reference quiescence and authoritative reference classification.
 * Required SDK response fields are checked, not inferred; unsupported shapes fail closed. */
export function createErasureStorageTransport(client: Client): ErasureStorageTransport {
  const read = async (prefix: string, signal: AbortSignal) => {
    check(bucket, signal);
    const result = await client.storage.from(bucket).listV2({
      prefix, limit: maximum, with_delimiter: false, sortBy: { column: 'name', order: 'asc' },
    }, { signal, cache: 'no-store' });
    check(bucket, signal);
    if (result.error) throw failure();
    const parsed = listing.safeParse(result.data);
    if (!parsed.success || parsed.data.hasNext || parsed.data.folders.length
      || parsed.data.objects.length > maximum || parsed.data.nextCursor) throw failure();
    const paths = parsed.data.objects.map(row => row.key);
    if (new Set(paths).size !== paths.length || paths.some(path =>
      !path.startsWith(prefix) || !isCanonicalErasureAttachment(path))) throw failure();
    return paths.sort();
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
