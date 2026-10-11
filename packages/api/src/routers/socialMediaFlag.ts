/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { readSocialMediaFlag, saveSocialMediaFlag, SOCIAL_MEDIA_FLAG_ERRORS } from '../services/skills/socialMediaFlag';
const moduleInput = z.object({ moduleId: z.string().uuid() }).strict();
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const raw = cause instanceof Error ? cause.message : '';
    const message = (SOCIAL_MEDIA_FLAG_ERRORS as readonly string[]).includes(raw) ? raw : 'SOCIAL_MEDIA_FLAG_UNAVAILABLE';
    throw new TRPCError({ code: message === 'SOCIAL_MEDIA_FLAG_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
}
export const socialMediaFlagRouter = router({
  get: adminProcedure.input(moduleInput).query(({ ctx, input }) =>
    safe(() => readSocialMediaFlag(ctx.supabase, input.moduleId))),
  update: adminProcedure.input(moduleInput.extend({
    socialMediaRelated: z.boolean(), expectedSocialMediaRelated: z.boolean(),
  }).strict()).mutation(({ ctx, input }) => safe(() => saveSocialMediaFlag(ctx.supabase, input))),
});
