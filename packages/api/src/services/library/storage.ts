/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { BUCKET, canonicalPath, MAX_BYTES } from './content';

const failure = () => new Error('LIBRARY_STORAGE_UNAVAILABLE');
const listing = z.object({
  hasNext: z.boolean(), nextCursor: z.string().nullish(), folders: z.array(z.unknown()),
  objects: z.array(z.object({ key: z.string().optional(), name: z.string().optional(), id: z.string().min(1) })),
});
export function libraryStorage(client: SupabaseClient) {
  const bucket = client.storage.from(BUCKET);
  const check = (path: string) => { if (!canonicalPath(path)) throw failure(); };
  const scan = async (prefix: string, cursor?: string) => {
    const result = await bucket.listV2({ prefix, limit: 100, with_delimiter: false,
      sortBy: { column: 'name', order: 'asc' }, ...(cursor ? { cursor } : {}),
    }, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (result.error) throw failure();
    const page = listing.parse(result.data);
    if (page.folders.length || page.objects.length > 100 || page.hasNext && (!page.nextCursor || !page.objects.length)
      || !page.hasNext && page.nextCursor) throw failure();
    const paths = page.objects.map(row => {
      const named = row.name === undefined ? undefined : row.name.includes('/') ? row.name
        : prefix.slice(0, prefix.lastIndexOf('/') + 1) + row.name;
      const key = row.key ?? named;
      if (!key || (row.key !== undefined && named !== undefined && row.key !== named)) throw failure();
      return key;
    });
    if (paths.some(path => !path || !path.startsWith(prefix)) || new Set(paths).size !== paths.length) throw failure();
    return { paths: paths as string[], cursor: page.hasNext ? page.nextCursor! : null };
  };
  return {
    scan,
    async signUpload(path: string) {
      check(path);
      const started = Date.now();
      const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: false });
      if (error || !data || Date.now() - started > 60_000) throw failure();
      return { signedUrl: data.signedUrl, token: data.token, path };
    },
    async signRead(path: string, download: string | false) {
      check(path);
      const { data, error } = await bucket.createSignedUrl(path, 60);
      if (error || !data) throw failure();
      if (download === false) return data.signedUrl;
      // Add the filename once via URLSearchParams: the SDK double-encodes its download option.
      // Never assemble a Content-Disposition header or concatenate untrusted URL parameters.
      const filename = download.replace(/[\x00-\x1f\x7f-\x9f/\\]/g, '_');
      const url = new URL(data.signedUrl);
      url.searchParams.set('download', filename.trim() ? filename : 'download');
      return url.toString();
    },
    async inspect(path: string, full: boolean, allowEmpty = false) {
      check(path);
      if (allowEmpty && (!full || !path.endsWith('/text'))) throw failure();
      const info = await bucket.info(path);
      if (info.error || !info.data) throw failure();
      const size = info.data.size;
      const contentType = info.data.contentType;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < (allowEmpty ? 0 : 1) || size > MAX_BYTES) throw new Error('LIBRARY_SIZE');
      const signed = await bucket.createSignedUrl(path, 60);
      if (signed.error || !signed.data) throw failure();
      // Only a service-created URL is fetched. No user URL, redirects, parser, or image decoder.
      const response = await fetch(signed.data.signedUrl, {
        headers: full ? {} : { Range: 'bytes=0-31' }, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) throw failure();
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (full && length + next.value.length > MAX_BYTES) throw new Error('LIBRARY_SIZE');
          const part = full ? next.value : next.value.subarray(0, Math.max(0, 32 - length));
          parts.push(part); length += part.length;
          if (!full && length >= 32) break;
        }
      } finally { await reader.cancel(); }
      if (full && length !== size) throw new Error('LIBRARY_SIZE');
      return { size, contentType, bytes: Buffer.concat(parts) };
    },
    async absent(path: string) {
      check(path);
      // Do not interpret SDK exists() false/error as absence. A successful complete exact-prefix listing is proof.
      const page = await scan(path);
      if (page.cursor) throw failure();
      return !page.paths.includes(path);
    },
    async remove(path: string) {
      check(path);
      const result = await bucket.remove([path]);
      if (result.error) throw failure();
    },
  };
}
export type LibraryStorage = ReturnType<typeof libraryStorage>;
