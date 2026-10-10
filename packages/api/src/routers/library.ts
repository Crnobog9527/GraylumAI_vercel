/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { beginInput } from '../services/library/content';
import { wordBeginInput, wordCompleteInput } from '../services/library/wordContent';
import { libraryService } from '../services/library/service';

// The existing tRPC HTTP entry enforces maintenance mode; actor is bound only from the session.
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'LIBRARY_UNAVAILABLE' });
  return next({ ctx: { ...ctx, library: libraryService(ctx.supabaseAdmin, ctx.profileId) } });
});
const document = z.object({ documentId: z.string().uuid() }).strict();
export const libraryRouter = router({
  beginWordUpload: procedure.input(wordBeginInput).mutation(({ ctx, input }) => ctx.library.beginWord(input)),
  completeWordUpload: procedure.input(wordCompleteInput).mutation(({ ctx, input }) => ctx.library.completeWord(input)),
  beginUpload: procedure.input(beginInput).mutation(({ ctx, input }) => ctx.library.begin(input)),
  completeUpload: procedure.input(document).mutation(({ ctx, input }) => ctx.library.complete(input.documentId)),
  abandonUpload: procedure.input(document).mutation(({ ctx, input }) => ctx.library.remove(input.documentId)),
  delete: procedure.input(document).mutation(({ ctx, input }) => ctx.library.remove(input.documentId)),
  download: procedure.input(document).mutation(({ ctx, input }) => ctx.library.signedUrl(input.documentId, false)),
  preview: procedure.input(document).mutation(({ ctx, input }) => ctx.library.signedUrl(input.documentId, true)),
  list: procedure.input(z.object({ afterId: z.string().uuid().optional(),
    cursor: z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.string().uuid() }).strict().optional(),
  }).strict().refine(input => !(input.afterId && input.cursor), 'LIBRARY_INVALID_CURSOR'))
    .query(({ ctx, input }) => ctx.library.list(input.afterId, input.cursor)),
  segments: procedure.input(document.extend({ version: z.number().int().positive(), start: z.number().int().min(0).max(9999).default(0),
    count: z.number().int().min(1).max(50).default(1) }))
    .query(({ ctx, input }) => ctx.library.segments(input.documentId, input.version, input.start, input.count)),
  directory: procedure.input(document.extend({ version: z.number().int().positive() }))
    .query(({ ctx, input }) => ctx.library.directory(input.documentId, input.version)),
  setPurpose: procedure.input(document.extend({ purpose: z.enum(['authored', 'reference']) }))
    .mutation(({ ctx, input }) => ctx.library.purpose(input.documentId, input.purpose)),
});
