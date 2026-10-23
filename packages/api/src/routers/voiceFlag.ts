/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { readVoiceFlag, saveVoiceFlag, VOICE_FLAG_ERRORS } from '../services/skills/voiceFlag';
const moduleInput = z.object({ moduleId: z.string().uuid() }).strict();
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const raw = cause instanceof Error ? cause.message : '';
    const message = (VOICE_FLAG_ERRORS as readonly string[]).includes(raw) ? raw : 'VOICE_FLAG_UNAVAILABLE';
    throw new TRPCError({ code: message === 'VOICE_FLAG_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
}
export const voiceFlagRouter = router({
  get: adminProcedure.input(moduleInput).query(({ ctx, input }) => safe(() => readVoiceFlag(ctx.supabase, input.moduleId))),
  update: adminProcedure.input(moduleInput.extend({
    usesUserVoice: z.boolean(), expectedUsesUserVoice: z.boolean(), expectedModuleUpdatedAt: z.string().min(1).max(64),
  }).strict()).mutation(({ ctx, input }) => safe(() => saveVoiceFlag(ctx.supabase, input))),
});
