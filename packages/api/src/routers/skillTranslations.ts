/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { readSkillTranslations, saveSkillTranslations, SKILL_TRANSLATION_ERRORS } from '../services/skills/skillTranslations';
import { SKILL_DISPLAY_LOCALES, skillLocaleTranslations } from '../shared/skillTranslations';
const moduleInput = z.object({ moduleId: z.string().uuid() }).strict();
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const raw = cause instanceof Error ? cause.message : '';
    const message = (SKILL_TRANSLATION_ERRORS as readonly string[]).includes(raw) ? raw : 'SKILL_TRANSLATIONS_UNAVAILABLE';
    throw new TRPCError({ code: message === 'SKILL_TRANSLATIONS_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
}
/** SKILL-I18N-HOOK: administrators only; users see translations once I18N-EN ships the English interface. */
export const skillTranslationsRouter = router({
  get: adminProcedure.input(moduleInput).query(({ ctx, input }) =>
    safe(() => readSkillTranslations(ctx.supabase, ctx.profileId, input.moduleId))),
  update: adminProcedure.input(moduleInput.extend({
    locale: z.enum(SKILL_DISPLAY_LOCALES), translations: skillLocaleTranslations,
    expectedModuleUpdatedAt: z.string().min(1).max(64),
  }).strict()).mutation(({ ctx, input }) => safe(() => saveSkillTranslations(ctx.supabase, ctx.profileId, input))),
});
