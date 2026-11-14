/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { generateVoiceProfile } from '../services/voice/generation';
import { confirmInput, enabledInput, generateInput, labelInput, voiceService } from '../services/voice/state';
import { importCandidatesInput, importPostsInput, voiceImportService } from '../services/voice/importPosts';

// VOICE (Owner 2026-10-23 "我的文风这个功能是核心功能，必须一起上线。"): the library page's "我的文风".
const procedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'VOICE_UNAVAILABLE' });
  return next({ ctx: { ...ctx, voice: voiceService(ctx.supabaseAdmin, ctx.profileId),
    voiceImport: voiceImportService(ctx.supabaseAdmin, ctx.profileId) } });
});
export const voiceRouter = router({
  state: procedure.query(({ ctx }) => ctx.voice.state()),
  generate: procedure.input(generateInput).mutation(({ ctx, input }) =>
    generateVoiceProfile({ admin: ctx.supabaseAdmin, actorId: ctx.profileId }, input.requestId, input.preferred)),
  confirm: procedure.input(confirmInput).mutation(({ ctx, input }) => ctx.voice.confirm(input)),
  setEnabled: procedure.input(enabledInput).mutation(({ ctx, input }) => ctx.voice.setEnabled(input)),
  delete: procedure.input(z.object({ versionId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) => ctx.voice.remove(input.versionId)),
  // VOICE-2 PR-4: correct one document's type or topics (used to pick the writing examples).
  setLabel: procedure.input(labelInput).mutation(({ ctx, input }) => ctx.voice.setLabel(input)),
  // VOICE-2 PR-5: import the user's own past posts from the latest paid read of an own connected account (no new charge).
  importSources: procedure.query(({ ctx }) => ctx.voiceImport.sources()),
  importCandidates: procedure.input(importCandidatesInput).query(({ ctx, input }) => ctx.voiceImport.candidates(input)),
  importPosts: procedure.input(importPostsInput).mutation(({ ctx, input }) => ctx.voiceImport.importPosts(input)),
});
