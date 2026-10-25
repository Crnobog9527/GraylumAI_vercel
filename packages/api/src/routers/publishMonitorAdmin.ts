/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../trpc';
import { readQuotaUsage } from '../services/publishMonitor/quota';
import { readStuckCleanup, requeueInput, requeueStuckCleanup, resolveStuckCleanup } from '../services/publishMonitor/stuckCleanup';

/**
 * PUBLISH-MONITOR plan §9 item 25: the admin view of Post for Me cleanup that stopped retrying ("外部待处理") and the
 * re-queue after a person handled it. Works while the feature switch is off: deletions owed to users never wait for it.
 */
async function safe<T>(hasAdmin: boolean, work: () => Promise<T>): Promise<T> {
  if (!hasAdmin) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_STUCK_UNAVAILABLE' });
  try { return await work(); } catch {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_STUCK_UNAVAILABLE' });
  }
}

export const publishMonitorAdminRouter = router({
  // This period's publish count against the Post for Me plan (read only; what the Owner compares with the usage report).
  quota: adminProcedure.query(({ ctx }) => safe(ctx.hasSupabaseAdminPrivileges, () => readQuotaUsage(ctx.supabaseAdmin))),
  stuck: adminProcedure.query(({ ctx }) => safe(ctx.hasSupabaseAdminPrivileges, () => readStuckCleanup(ctx.supabaseAdmin))),
  requeue: adminProcedure.input(requeueInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => requeueStuckCleanup(ctx.supabaseAdmin, input))),
  // After a person verified at Post for Me that the account is gone: ends the record instead of retrying it.
  resolve: adminProcedure.input(requeueInput).mutation(({ ctx, input }) =>
    safe(ctx.hasSupabaseAdminPrivileges, () => resolveStuckCleanup(ctx.supabaseAdmin, input))),
});
