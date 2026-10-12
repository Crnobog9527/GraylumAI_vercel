/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { recordAdminActivity } from '../services/adminUserAccess';
import { compensateStaleRound, findStaleChargedRounds, STALE_ROUND_REFUSALS } from '../services/runtime/staleChargedRounds';

/** Admin refunds page: the daily stale-round report and its verified compensation (Owner 2026-10-12). */
export const adminStaleRoundsRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
    try { return await findStaleChargedRounds(ctx.supabase); }
    catch { throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'STALE_ROUND_SCAN_FAILED' }); }
  }),
  compensate: adminProcedure.input(z.object({ runId: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    let result;
    try { result = await compensateStaleRound(ctx.supabase, input.runId); }
    catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if ((STALE_ROUND_REFUSALS as readonly string[]).includes(code))
        throw new TRPCError({ code: code === 'STALE_ROUND_NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED', message: code });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'STALE_ROUND_COMPENSATION_FAILED' });
    }
    // A repeated click returns the original outcome and is not audited twice.
    const auditRecorded = result.state === 'compensated' ? await recordAdminActivity(ctx.supabase, {
      user_id: result.actorId, admin_id: ctx.profileId, action: `回合补偿: +${result.compensatedCredits}`,
      action_type: 'credit_adjustment', details: { kind: 'stale_round_compensation', runId: result.runId,
        executionId: result.executionId, compensatedCredits: result.compensatedCredits },
    }) : true;
    return { state: result.state, runId: result.runId, compensatedCredits: result.compensatedCredits, auditRecorded };
  }),
});
