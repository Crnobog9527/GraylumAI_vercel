/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { checkRateLimitAsync } from '../../middleware/securityChecks';
import { cleanupLibrary } from './cleanup';
import { libraryRpc } from './rpc';
import type { LibraryStorage } from './storage';
import { WORD_MIME, wordBeginInput, wordCompleteInput, wordFilename, wordSegments } from './wordContent';

type WordDocument = { format: string; status: string; path: string; textPath: string | null };
export function wordUpload(client: SupabaseClient, actorId: string, storage: LibraryStorage) {
  const read = (id: string) => libraryRpc<WordDocument>(client, 'library_document_read', {
    a: actorId, did: id, require_ready: false,
  });
  const discard = async (id: string) => {
    await libraryRpc(client, 'library_delete', { a: actorId, did: id, unfinished_only: true });
    await cleanupLibrary(client, { actorId, documentId: id, limit: 1, storage });
  };
  return {
    async beginWord(raw: z.infer<typeof wordBeginInput>) {
      const input = wordBeginInput.parse(raw);
      wordFilename(input.filename);
      await checkRateLimitAsync(actorId, 'api');
      const started = Date.now();
      const grant = await libraryRpc<{
        documentId: string; status: string; dispatch: boolean; path?: string; textPath?: string;
      }>(client, 'library_upload_begin', { a: actorId, r: input.requestId, n: input.filename,
        f: 'docx', p: input.purpose, declared: input.bytes });
      if (!grant.dispatch) return { documentId: grant.documentId, status: grant.status, uploads: null };
      if (Date.now() - started > 60_000) throw new Error('LIBRARY_UPLOAD_EXPIRED');
      try {
        if (!grant.path || !grant.textPath) throw new Error('LIBRARY_UPLOAD_UNAVAILABLE');
        // Both paths are held before either signed token exists. Partial signing is cleaned conservatively.
        const original = await storage.signUpload(grant.path);
        if (Date.now() - started > 60_000) throw new Error('LIBRARY_UPLOAD_EXPIRED');
        const text = await storage.signUpload(grant.textPath);
        if (Date.now() - started > 120_000) throw new Error('LIBRARY_UPLOAD_EXPIRED');
        await read(grant.documentId);
        return { documentId: grant.documentId, status: grant.status, uploads: { original, text } };
      } catch {
        await discard(grant.documentId);
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'LIBRARY_UPLOAD_UNAVAILABLE' });
      }
    },
    async completeWord(raw: z.infer<typeof wordCompleteInput>) {
      const input = wordCompleteInput.parse(raw);
      await checkRateLimitAsync(actorId, 'api');
      const doc = await read(input.documentId);
      if (doc.format !== 'docx' || !doc.textPath) throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_TYPE' });
      if (doc.status === 'ready') return { documentId: input.documentId, status: 'ready' as const };
      try {
        const original = await storage.inspect(doc.path, false);
        if (original.contentType !== WORD_MIME || !original.bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
          throw new Error('LIBRARY_TYPE');
        }
        const text = await storage.inspect(doc.textPath, true);
        if (text.contentType !== 'text/plain') throw new Error('LIBRARY_TYPE');
        const segments = wordSegments(text.bytes, input.headings);
        return await libraryRpc<{ documentId: string; status: 'ready' }>(client, 'library_word_publish', {
          a: actorId, did: input.documentId, actual: original.size, text_actual: text.size, segments,
        });
      } catch (error) {
        await discard(input.documentId);
        const message = error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message)
          ? error.message : 'LIBRARY_UPLOAD_UNAVAILABLE';
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
    },
  };
}
