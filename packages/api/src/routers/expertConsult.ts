/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import {
  ExpertConsultError, expertConsultInput, readExpertConsult, requestExpertConsult,
} from '../services/expertConsult/request';

/** EXPERT-CONSULT: a signed-in user reads and creates only their own booking request. */
async function safe<T>(hasAdmin: boolean, work: () => Promise<T>): Promise<T> {
  if (!hasAdmin) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'EXPERT_CONSULT_UNAVAILABLE' });
  try { return await work(); }
  catch (cause) {
    const code = cause instanceof ExpertConsultError ? cause.code : 'EXPERT_CONSULT_UNAVAILABLE';
    throw new TRPCError({ code: code === 'EXPERT_CONSULT_INVALID' ? 'BAD_REQUEST'
      : code === 'EXPERT_CONSULT_UNAVAILABLE' ? 'INTERNAL_SERVER_ERROR' : 'FORBIDDEN', message: code, cause });
  }
}
export const expertConsultRouter = router({
  state: protectedProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => readExpertConsult(ctx.supabaseAdmin, ctx.profileId))),
  request: protectedProcedure.input(expertConsultInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => requestExpertConsult(ctx.supabaseAdmin, ctx.profileId, input))),
});
