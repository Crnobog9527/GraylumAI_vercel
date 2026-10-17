/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { withdrawGaConsent } from '../services/analytics/gaPurchase';

/** ANALYTICS §3.1: the browser reports a statistics-consent withdrawal so the account's pending GA ids are dropped. */
export const analyticsRouter = router({
  withdrawConsent: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.hasSupabaseAdminPrivileges) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'ANALYTICS_UNAVAILABLE' });
    try {
      await withdrawGaConsent(ctx.supabaseAdmin, ctx.profileId);
      return { ok: true as const };
    } catch (cause) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'ANALYTICS_UNAVAILABLE', cause });
    }
  }),
});
