/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../trpc';
import { adminEvidence } from '../services/fusion/reviewEvidenceFlow';
import { fusionSettings } from '../services/fusion/settings';
import { fusionModelOptions, fusionSettingsView, saveFusionSettings } from '../services/fusion/settingsAdmin';

const unavailable = new Set(['FUSION_SETTINGS_UNAVAILABLE']);
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const code = cause instanceof Error && /^(FUSION|RUNTIME|BILL2)_[A-Z_]+$/.test(cause.message) ? cause.message
      : 'FUSION_SETTINGS_UNAVAILABLE';
    throw new TRPCError({ code: unavailable.has(code) ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', message: code, cause });
  }
}
/** Dedicated Fusion settings (Master Plan §4.5); the generic settings route refuses this key. */
export const fusionSettingsRouter = router({
  get: adminProcedure.query(({ ctx }) => safe(() => fusionSettingsView(ctx.supabase))),
  update: adminProcedure.input(fusionSettings).mutation(({ ctx, input }) =>
    safe(() => saveFusionSettings(ctx.supabase, ctx.user.id, input))),
  /** Models the panel may use, per purpose, checked by the Fusion admission (not the report one). Read-only. */
  models: adminProcedure.query(({ ctx }) => safe(() => fusionModelOptions(ctx.supabase, ctx.user.id))),
  /** Look-back at real reviews (Owner 2026-10-14 "边用边调"): newest first, keyset paged. */
  reviews: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(20),
    before: z.object({ createdAt: z.string().datetime({ offset: true }), reviewId: z.string().uuid() }).strict().optional() }).strict())
    .query(({ ctx, input }) => safe(async () => {
      const result = await ctx.supabase.rpc('fusion_review_admin_list', { p_limit: input.limit,
        p_before_created: input.before?.createdAt ?? null, p_before_id: input.before?.reviewId ?? null });
      if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
      return result.data as unknown[];
    })),
  /** One review with each call's saved output, model and cost. */
  review: adminProcedure.input(z.object({ reviewId: z.string().uuid() }).strict()).query(({ ctx, input }) => safe(async () => {
    const result = await ctx.supabase.rpc('fusion_review_admin_read', { p_review_id: input.reviewId });
    if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
    if (!result.data) throw new Error('FUSION_REVIEW_NOT_FOUND');
    const raw = result.data as Record<string, unknown>;
    // Reviews started with the evidence check also show what the host held back (by reason) and the thin rulings.
    if ((raw.config as { evidence?: boolean } | null)?.evidence !== true) return raw;
    const source = await ctx.supabase.rpc('fusion_review_source', { p_actor_id: String(raw.actorId), p_review_id: input.reviewId });
    const parsed = z.object({ body: z.string(), sections: z.array(z.string()) }).safeParse(source.data);
    return source.error || !parsed.success ? raw : adminEvidence(raw, parsed.data);
  })),
  /** Unblocks a version stopped by "3 failures in a row": marks its counted failures as not counting, with a
   * reason; nothing is deleted and the marking (who, when, why, which reviews) stays on the records. */
  clearBreaker: adminProcedure.input(z.object({ sourceVersionId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict())
    .mutation(({ ctx, input }) => safe(async () => {
      const result = await ctx.supabase.rpc('fusion_review_breaker_clear', { p_admin_id: ctx.user.id,
        p_source_version_id: input.sourceVersionId, p_reason: input.reason });
      if (result.error) throw new Error(/^FUSION_[A-Z_]+$/.test(result.error.message) ? result.error.message : 'FUSION_SETTINGS_UNAVAILABLE');
      return result.data as { batch: string; sourceVersionId: string; reviewIds: string[]; reason: string };
    })),
});
