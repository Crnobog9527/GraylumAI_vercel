/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { checkRateLimitAsync } from '../../middleware/securityChecks';
import { beginInput, formatFor, formats, textSegments, verifyHeader, type Format } from './content';
import { cleanupLibrary } from './cleanup';
import { pdfUpload } from './pdfUpload';
import { wordUpload } from './wordUpload';
import { libraryRecognition } from './recognition';
import { libraryRpc } from './rpc';
import { scheduleErasureManifestSync } from '../accountErasure/offdbManifest';
import { libraryStorage, type LibraryStorage } from './storage';

type LibraryItem = {
  id: string; kind: 'document' | 'image' | 'audio' | 'video'; format: string | null;
  purpose: 'authored' | 'reference' | null; filename: string | null;
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'deleting';
  original_bytes: number; text_bytes: number; content_version: number; created_at: string;
};
export type LibraryCursor = { createdAt: string; id: string };
type LibraryList = { usedBytes: number; capacityBytes: number; uploadEnabled: boolean;
  documents: LibraryItem[]; nextCursor: LibraryCursor | null };
type LibrarySearch = { documents: LibraryItem[]; nextCursor: LibraryCursor | null };
type LibrarySegment = { ordinal: number; title: string; body: string; bytes: number;
  page_number: number | null; source: 'extracted' | 'recognized' };

type Document = { filename: string | null; id: string; format: Format; kind: string; path: string; status: string; guardUntil: string };
export function libraryService(client: SupabaseClient, actorId: string, storage: LibraryStorage = libraryStorage(client)) {
  const read = (documentId: string, ready = true) => libraryRpc<Document>(client, 'library_document_read', {
    a: actorId, did: documentId, require_ready: ready,
  });
  const sweep = () => cleanupLibrary(client, { actorId, limit: 4, budgetMs: 5000, storage });
  const remove = async (documentId: string, unfinishedOnly = false) => {
    const result = await libraryRpc<{ status: string }>(client, 'library_delete', { a: actorId, did: documentId, unfinished_only: unfinishedOnly });
    if (result.status === 'deleting') scheduleErasureManifestSync(client);
    await cleanupLibrary(client, { actorId, documentId, limit: 1, storage });
    return result;
  };
  return {
    ...wordUpload(client, actorId, storage),
    ...pdfUpload(client, actorId, storage),
    ...libraryRecognition(client, actorId),
    async begin(raw: z.infer<typeof beginInput>) {
      const input = beginInput.parse(raw);
      const format = formatFor(input.filename, input.contentType);
      await checkRateLimitAsync(actorId, 'api');
      await sweep();
      const started = Date.now();
      const grant = await libraryRpc<{ documentId: string; dispatch: boolean; path?: string; status: string }>(
        client, 'library_upload_begin', { a: actorId, r: input.requestId, n: input.filename,
          f: format, p: input.purpose, declared: input.bytes },
      );
      if (!grant.dispatch || !grant.path) return { documentId: grant.documentId, status: grant.status, upload: null };
      if (Date.now() - started > 60_000) throw new Error('LIBRARY_UPLOAD_EXPIRED');
      try {
        const upload = await storage.signUpload(grant.path);
        await read(grant.documentId, false);
        return { documentId: grant.documentId, status: grant.status, upload };
      } catch {
        await remove(grant.documentId, true);
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'LIBRARY_UPLOAD_UNAVAILABLE' });
      }
    },
    async complete(documentId: string) {
      await checkRateLimitAsync(actorId, 'api');
      const doc = await read(documentId, false);
      if (!(doc.format in formats)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_TYPE' });
      if (doc.status === 'ready') return { documentId, status: 'ready' };
      try {
        const file = await storage.inspect(doc.path, doc.kind === 'document');
        if (file.contentType !== formats[doc.format]) throw new Error('LIBRARY_TYPE');
        verifyHeader(doc.format, file.bytes);
        const segments = doc.kind === 'document' ? textSegments(file.bytes) : [];
        return await libraryRpc<{ documentId: string; status: 'ready' }>(client, 'library_publish', {
          a: actorId, did: documentId, actual: file.size, segments,
        });
      } catch (error) {
        await remove(documentId, true);
        const message = error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message)
          ? error.message : 'LIBRARY_UPLOAD_UNAVAILABLE';
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
    },
    remove,
    async signedUrl(documentId: string, preview: boolean) {
      const doc = await read(documentId);
      if (preview && doc.kind !== 'image') throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_TYPE' });
      const url = await storage.signRead(doc.path, preview ? false : doc.filename ?? 'download');
      await read(documentId); // Do not return a newly minted link after a concurrent deletion/erasure.
      return { url, expiresIn: 60 };
    },
    // Reading never cleans up (ARCH-FIX A1): the library-cleanup cron (every 5 minutes), begin and
    // remove do. Reads are limited per user by the protectedProcedure middleware.
    list(afterId?: string, cursor?: LibraryCursor) {
      return cursor
        ? libraryRpc<LibraryList>(client, 'library_list_page', { a: actorId,
          after_id: cursor.id, after_created_at: cursor.createdAt })
        : libraryRpc<LibraryList>(client, 'library_list', { a: actorId, after_id: afterId ?? null });
    },
    /** Own ready text documents with readable text whose file name contains `query` literally (the database escapes it). */
    search(query: string, cursor?: LibraryCursor) {
      return libraryRpc<LibrarySearch>(client, 'library_search', { a: actorId, q: query,
        after_created_at: cursor?.createdAt ?? null, after_id: cursor?.id ?? null });
    },
    segments(documentId: string, version: number, start: number, count = 1) {
      return libraryRpc<LibrarySegment[]>(client, 'library_segments_range', {
        a: actorId, did: documentId, ver: version, start_at: start, count_limit: count,
      });
    },
    directory(documentId: string, version: number) {
      return libraryRpc<Pick<LibrarySegment, 'ordinal' | 'title'>[]>(client, 'library_directory', {
        a: actorId, did: documentId, ver: version,
      });
    },
    purpose(documentId: string, purpose: 'authored' | 'reference') {
      return libraryRpc<null>(client, 'library_purpose', { a: actorId, did: documentId, p: purpose });
    },
  };
}
