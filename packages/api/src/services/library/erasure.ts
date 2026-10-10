/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { cleanupLibrary } from './cleanup';
import { canonicalPath } from './content';
import { libraryRpc } from './rpc';
import { libraryStorage, type LibraryStorage } from './storage';
import type { ErasureStorageAdapter } from '../accountErasure/processor';

/** The existing executor claim owns both buckets. Deleting the first bounded page
 * makes restart progress without sharing the ticket bucket's opaque cursor.
 * No prefix proof is recorded while any signed-upload reservation can still arrive. */
export function createLibraryErasureAdapter(client: SupabaseClient, input: {
  profileId: string; requestId: string; token: string; storage?: LibraryStorage;
}): ErasureStorageAdapter {
  return { async cleanSubject(profileId) {
    if (profileId !== input.profileId) throw new Error('ERASURE_IDENTITY_CHANGED');
    const binding = { a: profileId, rid: input.requestId, token: input.token };
    if (z.boolean().parse(await libraryRpc(client, 'library_erasure_proof', binding))) {
      return { complete: true, remaining: 0, manualReview: 0 };
    }
    const storage = input.storage ?? libraryStorage(client);
    const cleaned = await cleanupLibrary(client, { actorId: profileId, storage, limit: 50, budgetMs: 2000 });
    const remaining = z.coerce.number().int().nonnegative().safe().parse(
      await libraryRpc(client, 'library_erasure_remaining', { a: profileId }),
    );
    if (remaining || cleaned.failed) return { complete: false, remaining: Math.max(1, remaining), manualReview: 0 };
    const page = await storage.scan(`${profileId}/`);
    let manualReview = 0;
    const deadline = Date.now() + 2000;
    for (const path of page.paths) {
      if (Date.now() >= deadline) return { complete: false, remaining: 1, manualReview };
      if (!canonicalPath(path) || !path.startsWith(`${profileId}/`)) { manualReview++; continue; }
      if (!await storage.absent(path)) await storage.remove(path);
      if (!await storage.absent(path)) return { complete: false, remaining: 1, manualReview };
    }
    // Fresh empty enumeration after deletion, never a stale pre-delete continuation.
    const after = await storage.scan(`${profileId}/`);
    if (after.paths.length || after.cursor || manualReview) {
      return { complete: false, remaining: Math.max(1, after.paths.length), manualReview };
    }
    const complete = z.boolean().parse(await libraryRpc(client, 'library_erasure_proof', { ...binding, verified: true }));
    return { complete, remaining: complete ? 0 : 1, manualReview: 0 };
  } };
}
