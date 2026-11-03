/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import {
  deleteDiagnostic, diagnosticDeleteInput, diagnosticInput, listCandidates, listDiagnostics, saveDiagnostic,
} from '../services/publishMonitor/diagnostics';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import { guarded as safe } from './publishMonitorGuard';

/**
 * PUBLISH-MONITOR RC: the single-post diagnosis layer (Pro and Gold, Owner 2026-10-27 item D). The user's own posts, the rates they type
 * for them and the confirmation; removing a diagnosis of one's own is always allowed, even while the feature is paused.
 */
type Ctx = { profileId: string; supabaseAdmin: Parameters<typeof readMembershipEntitlements>[0] };
async function allowed(ctx: Ctx) {
  const days = (await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId)).ownDataWindowDays;
  if (days <= 0) throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
}

export const publishMonitorDiagnosticsRouter = router({
  candidates: protectedProcedure.query(({ ctx }) => safe(ctx, async () => {
    await allowed(ctx);
    return listCandidates(ctx.supabaseAdmin, ctx.profileId);
  })),
  list: protectedProcedure.query(({ ctx }) => safe(ctx, async () => {
    await allowed(ctx);
    return listDiagnostics(ctx.supabaseAdmin, ctx.profileId);
  })),
  save: protectedProcedure.input(diagnosticInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    await allowed(ctx);
    await checkRateLimitOrThrow(`publish-monitor-diagnostic:${ctx.profileId}`, 'api');
    return saveDiagnostic(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  remove: protectedProcedure.input(diagnosticDeleteInput).mutation(({ ctx, input }) =>
    safe(ctx, () => deleteDiagnostic(ctx.supabaseAdmin, ctx.profileId, input), false)),
});
