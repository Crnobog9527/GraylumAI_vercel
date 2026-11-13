/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { ErasureStorageAdapter } from '../accountErasure/processor';
import { AVATAR_BUCKET, isAvatarObjectPath } from './storage';

const PAGE = 100;
const listing = z.array(z.object({ name: z.string(), id: z.string().nullable().optional() }).passthrough()).max(PAGE);
export type ErasureBucket = {
  list(prefix: string, options: { limit: number; offset: number; sortBy: { column: string; order: string } }):
    PromiseLike<{ data: unknown; error: unknown }>;
  remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }>;
};
type Bucket = ErasureBucket;
export type AvatarErasureClient = { storage: { from(bucket: string): Bucket } };

type Cleaned = Awaited<ReturnType<ErasureStorageAdapter['cleanSubject']>>;

/** Erasure of everything under `<profile id>/` in one service-only bucket: every object there is the subject's own (no
 * references to classify). Complete only when a fresh listing after the deletes is empty; any failure is "not yet", never
 * "done", so Auth deletion waits for the next run. A folder or a name the service never writes is left for a person. Shared by
 * the avatar and the Shotviva photo buckets. */
export async function cleanOwnPrefix(bucket: Bucket, profileId: string, owns: (path: string) => boolean,
  codes: { unknown: string; review: string }): Promise<Cleaned> {
  const unknown = { complete: false, remaining: 1, manualReview: 0, errorCode: codes.unknown };
  const scan = async () => {
    const result = await bucket.list(profileId, { limit: PAGE, offset: 0, sortBy: { column: 'name', order: 'asc' } });
    if (result.error) throw new Error('list');
    return listing.parse(result.data ?? []).map(row => ({ path: `${profileId}/${row.name}`, folder: !row.id }));
  };
  try {
    const found = await scan();
    const strange = found.filter(row => row.folder || !owns(row.path));
    const ours = found.filter(row => !strange.includes(row)).map(row => row.path);
    if (ours.length) {
      const removed = await bucket.remove(ours);
      if (removed.error) return unknown;
    }
    const after = await scan();
    if (strange.length) return { complete: false, remaining: after.length, manualReview: strange.length, errorCode: codes.review };
    return after.length ? { complete: false, remaining: after.length, manualReview: 0 } : { complete: true, remaining: 0, manualReview: 0 };
  } catch { return unknown; }
}

/** Erasure of everything under `<profile id>/` in the avatar bucket. */
export function createAvatarErasureAdapter(client: AvatarErasureClient): ErasureStorageAdapter {
  return { cleanSubject: profileId => cleanOwnPrefix(client.storage.from(AVATAR_BUCKET), profileId,
    path => isAvatarObjectPath(path, profileId),
    { unknown: 'ERASURE_AVATAR_STORAGE_UNKNOWN', review: 'ERASURE_AVATAR_STORAGE_REVIEW' }) };
}

/** Run the second-bucket cleanups in order; a later bucket runs only once the earlier one is complete. */
export function chainErasureStorage(...adapters: ErasureStorageAdapter[]): ErasureStorageAdapter {
  return { async cleanSubject(profileId) {
    let last: Cleaned = { complete: true, remaining: 0, manualReview: 0 };
    for (const adapter of adapters) {
      last = await adapter.cleanSubject(profileId);
      if (!last.complete) return last;
    }
    return last;
  } };
}
