/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, protectedProcedure, router } from '../trpc';
import { withdrawGaConsent } from '../services/analytics/gaPurchase';
import { dispatchPvuv, pvuvVisitorId, sendPvuvEvent, signupEvent } from '../services/analytics/pvuv';
import { recordSignupAttribution, signupSourceReport } from '../services/analytics/signupAttribution';

/** ANALYTICS §3.1: consent withdrawal drops pending GA ids. §3.2: first source of a new account, and its admin report. */
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
  // Statistics only: always answers ok, so the browser never retries or shows anything.
  recordSignupAttribution: protectedProcedure.input(z.object({ attribution: z.unknown() }).strict()).mutation(async ({ ctx, input }) => {
    if (ctx.hasSupabaseAdminPrivileges) await recordSignupAttribution(ctx.supabaseAdmin, ctx.profileId, input.attribution);
    return { ok: true as const };
  }),
  // ANALYTICS-PVUV: the account was created. Sent whatever the browser's consent is; the visitor id goes along only when the
  // request carries pvuv's own cookie (it exists only while consent is live). Repeats share one dedupe id.
  reportSignup: protectedProcedure.input(z.object({ method: z.enum(['google', 'phone', 'email']) }).strict()).mutation(async ({ ctx, input }) => {
    dispatchPvuv(() => sendPvuvEvent(signupEvent(ctx.profileId, input.method, pvuvVisitorId(ctx.headers))), ctx.scheduleAfter);
    return { ok: true as const };
  }),
  signupSources: adminProcedure.input(z.object({ days: z.number().int().min(1).max(400) }).strict()).query(async ({ ctx, input }) => {
    try {
      return await signupSourceReport(ctx.supabaseAdmin, input.days);
    } catch (cause) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'ANALYTICS_UNAVAILABLE', cause });
    }
  }),
});
