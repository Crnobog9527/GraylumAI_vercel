/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { adminProcedure, protectedProcedure, router } from '../trpc';
import {
  founderAdminOverview, founderCommunityEntryInput, founderCommunityMarkInput, founderLivestreamInput, founderWallReviewInput,
  getFounderCommunityEntry,
  listFounderLivestreams, markFounderCommunity, recordFounderLivestream, reviewFounderWall, setFounderCommunityEntry,
} from '../services/founder/admin';
import { FounderError, readFounderMember, submitFounderWall, withdrawFounderWall } from '../services/founder/member';
import { founderWallSubmitInput } from '../services/founder/schemas';

/**
 * PAY-FOUNDER PR-F1. Members read and change only their own card (profile id from the session); the public
 * wall is read server-side by the page (readFounderWallPublic), not through this router.
 */
async function safe<T>(hasAdmin: boolean, work: () => Promise<T>): Promise<T> {
  if (!hasAdmin) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'FOUNDER_UNAVAILABLE' });
  try { return await work(); }
  catch (cause) {
    if (cause instanceof TRPCError) throw cause;
    const code = cause instanceof FounderError ? cause.code : 'FOUNDER_UNAVAILABLE';
    throw new TRPCError({ code: trpcCode(code), message: code, cause });
  }
}
function trpcCode(code: string) {
  if (code === 'FOUNDER_WALL_VERSION_STALE' || code === 'FOUNDER_WALL_ENTRY_CHANGED') return 'CONFLICT' as const;
  if (code === 'FOUNDER_WALL_NOT_FOUNDER' || code === 'FOUNDER_ACCOUNT_CLOSED' || code === 'FOUNDER_ADMIN_DENIED') {
    return 'FORBIDDEN' as const;
  }
  if (code === 'FOUNDER_WALL_ENTRY_MISSING' || code === 'FOUNDER_NOT_FOUND') return 'NOT_FOUND' as const;
  if (code.endsWith('_INVALID') || code === 'FOUNDER_COMMUNITY_NOT_JOINED') return 'BAD_REQUEST' as const;
  return 'INTERNAL_SERVER_ERROR' as const;
}

const founderAdminRouter = router({
  overview: adminProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => founderAdminOverview(ctx.supabaseAdmin, ctx.user.id))),
  communityEntry: adminProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => getFounderCommunityEntry(ctx.supabaseAdmin))),
  reviewWall: adminProcedure.input(founderWallReviewInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => reviewFounderWall(ctx.supabaseAdmin, ctx.user.id, input))),
  markCommunity: adminProcedure.input(founderCommunityMarkInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => markFounderCommunity(ctx.supabaseAdmin, ctx.user.id, input))),
  setCommunityEntry: adminProcedure.input(founderCommunityEntryInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => setFounderCommunityEntry(ctx.supabaseAdmin, ctx.user.id, input))),
  livestreams: adminProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => listFounderLivestreams(ctx.supabaseAdmin, ctx.user.id))),
  recordLivestream: adminProcedure.input(founderLivestreamInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => recordFounderLivestream(ctx.supabaseAdmin, ctx.user.id, input))),
});

export const founderRouter = router({
  me: protectedProcedure.query(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => readFounderMember(ctx.supabaseAdmin, ctx.profileId))),
  submitWall: protectedProcedure.input(founderWallSubmitInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => submitFounderWall(ctx.supabaseAdmin, ctx.profileId, input))),
  withdrawWall: protectedProcedure.mutation(({ ctx }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => withdrawFounderWall(ctx.supabaseAdmin, ctx.profileId))),
  admin: founderAdminRouter,
});
