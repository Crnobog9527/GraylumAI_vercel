/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import type { beginInput } from './content';
import { checkRateLimitAsync } from '../../middleware/securityChecks';
import { cleanupLibrary } from './cleanup';
import { libraryRpc } from './rpc';
import type { LibraryStorage } from './storage';


type ExtractedDocument = { format: string; status: string; path: string; textPath: string | null; textGuardUntil: string | null };
type Grant = { documentId: string; status: string; dispatch: boolean; path?: string };
type Config = { format: 'docx' | 'pdf'; mime: string; magic: Buffer };
type Publication = { rpc: string; args: Record<string, unknown> };
export function extractedUpload(client: SupabaseClient, actorId: string, storage: LibraryStorage, config: Config) {
  const read = (id: string) => libraryRpc<ExtractedDocument>(client, 'library_document_read', {
    a: actorId, did: id, require_ready: false,
  });
  const discard = async (id: string) => {
    await libraryRpc(client, 'library_delete', { a: actorId, did: id, unfinished_only: true });
    await cleanupLibrary(client, { actorId, documentId: id, limit: 1, storage });
  };
  const original = async (path: string) => {
    const file = await storage.inspect(path, false);
    if (file.contentType !== config.mime || !file.bytes.subarray(0, config.magic.length).equals(config.magic)) {
      throw new Error('LIBRARY_TYPE');
    }
    return file;
  };
  const dispatch = async (grant: Grant, started: number) => {
    if (!grant.dispatch) return { documentId: grant.documentId, status: grant.status, upload: null };
    if (Date.now() - started > 60_000) throw new Error('LIBRARY_UPLOAD_EXPIRED');
    try {
      if (!grant.path) throw new Error('LIBRARY_UPLOAD_UNAVAILABLE');
      const upload = await storage.signUpload(grant.path);
      await read(grant.documentId);
      return { documentId: grant.documentId, status: grant.status, upload };
    } catch {
      await discard(grant.documentId);
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'LIBRARY_UPLOAD_UNAVAILABLE' });
    }
  };
  return {
    async begin(input: Omit<z.infer<typeof beginInput>, 'contentType'>) {
      await checkRateLimitAsync(actorId, 'api');
      await cleanupLibrary(client, { actorId, limit: 4, budgetMs: 5000, storage });
      const started = Date.now();
      const grant = await libraryRpc<Grant>(client, 'library_upload_begin', {
        a: actorId, r: input.requestId, n: input.filename, f: config.format, p: input.purpose, declared: input.bytes,
      });
      // Both paths are reserved, but only original is dispatched at this stage.
      return dispatch(grant, started);
    },
    async beginText(documentId: string) {
      await checkRateLimitAsync(actorId, 'api');
      const doc = await read(documentId);
      if (doc.format !== config.format || !doc.textPath) throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_TYPE' });
      if (doc.textGuardUntil || doc.status === 'ready') return { documentId, status: doc.status, upload: null };
      // Successful original inspection is required before the atomic second-stage grant.
      // A missing/in-flight original can be retried; no text token or extra hold has been issued yet.
      let file: Awaited<ReturnType<typeof original>>;
      try { file = await original(doc.path); }
      catch (error) {
        const message = error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message)
          ? error.message : 'LIBRARY_UPLOAD_UNAVAILABLE';
        if (message === 'LIBRARY_TYPE' || message === 'LIBRARY_SIZE') await discard(documentId);
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
      const started = Date.now();
      const rpc = config.format === 'pdf' ? 'library_pdf_text_begin' : 'library_word_text_begin';
      const grant = await libraryRpc<Grant>(client, rpc, { a: actorId, did: documentId, actual: file.size });
      return dispatch(grant, started);
    },
    async complete(documentId: string, publish: (bytes: Buffer) => Publication) {
      await checkRateLimitAsync(actorId, 'api');
      const doc = await read(documentId);
      if (doc.format !== config.format || !doc.textPath) throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_TYPE' });
      if (doc.status === 'ready') return { documentId, status: 'ready' as const };
      if (!doc.textGuardUntil) throw new TRPCError({ code: 'BAD_REQUEST', message: 'LIBRARY_UPLOAD_INCOMPLETE' });
      try {
        const file = await original(doc.path);
        const text = config.format === 'pdf' ? await storage.inspect(doc.textPath, true, true)
          : await storage.inspect(doc.textPath, true);
        if (text.contentType !== 'text/plain') throw new Error('LIBRARY_TYPE');
        const publication = publish(text.bytes);
        return await libraryRpc<{ documentId: string; status: 'ready' }>(client, publication.rpc, {
          a: actorId, did: documentId, actual: file.size, text_actual: text.size, ...publication.args,
        });
      } catch (error) {
        await discard(documentId);
        const message = error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message)
          ? error.message : 'LIBRARY_UPLOAD_UNAVAILABLE';
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
    },
  };
}
