import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { confirmAccountErasure, loadAccountErasurePreview } from '../services/accountErasure/service';
import { readAccountErasureProgress } from '../services/accountErasure/progress';

function requireServiceRole(hasSupabaseAdminPrivileges: boolean) {
  if (!hasSupabaseAdminPrivileges) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '注销服务暂时不可用，请稍后重试' });
  }
}

export const accountRouter = router({
  // Validation stays inside the service so malformed, expired and unknown credentials all return NOT_FOUND.
  erasureProgress: publicProcedure.input(z.unknown()).mutation(async ({ ctx, input }) => {
    requireServiceRole(ctx.hasSupabaseAdminPrivileges);
    return readAccountErasureProgress(ctx.supabaseAdmin, input);
  }),
  erasurePreview: protectedProcedure.query(async ({ ctx }) => {
    requireServiceRole(ctx.hasSupabaseAdminPrivileges);
    return loadAccountErasurePreview(ctx.supabaseAdmin, ctx.profileId);
  }),

  erasureConfirm: protectedProcedure
    .input(z.object({ requestId: z.string().uuid(), acknowledged: z.literal(true) }).strict())
    .mutation(async ({ ctx, input }) => {
      requireServiceRole(ctx.hasSupabaseAdminPrivileges);
      return confirmAccountErasure({
        admin: ctx.supabaseAdmin,
        authClient: ctx.supabaseAuth,
        headers: ctx.headers,
        userId: ctx.profileId,
        requestId: input.requestId,
        nowMs: Date.now(),
      });
    }),
});
