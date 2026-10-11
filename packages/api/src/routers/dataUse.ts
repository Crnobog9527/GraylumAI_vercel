/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { DataUseError, dataUseConsentInput, readDataUseConsent, setDataUseConsent } from '../services/dataUse/consent';

/** Personal-center D5 switch: a user reads and changes only their own consent. */
async function safe<T>(hasAdmin: boolean, work: () => Promise<T>): Promise<T> {
  if (!hasAdmin) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DATA_USE_UNAVAILABLE' });
  try { return await work(); }
  catch (cause) {
    const code = cause instanceof DataUseError ? cause.code : 'DATA_USE_UNAVAILABLE';
    throw new TRPCError({ code: code === 'DATA_USE_VERSION_STALE' ? 'CONFLICT'
      : code === 'DATA_USE_ACCOUNT_CLOSED' ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR', message: code, cause });
  }
}
export const dataUseRouter = router({
  consent: protectedProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => readDataUseConsent(ctx.supabaseAdmin, ctx.profileId))),
  setConsent: protectedProcedure.input(dataUseConsentInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => setDataUseConsent(ctx.supabaseAdmin, ctx.profileId, input))),
});
