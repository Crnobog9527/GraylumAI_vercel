/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import {
  assertPublishMonitorEnabled, autoReviewInput, listConnections, PublishMonitorError,
  readPublishMonitorSettings, setAutoReview,
} from '../services/publishMonitor/foundation';

/** PUBLISH-MONITOR: a user reads and changes only their own monitoring state; off until enabled by admin. */
type SwitchReader = Parameters<typeof assertPublishMonitorEnabled>[0];
async function safe<T>(ctx: { hasSupabaseAdminPrivileges: boolean; supabaseAdmin: SwitchReader },
  work: () => Promise<T>, requireSwitch = true): Promise<T> {
  if (!ctx.hasSupabaseAdminPrivileges) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'PUBLISH_MONITOR_UNAVAILABLE' });
  }
  try {
    if (requireSwitch) await assertPublishMonitorEnabled(ctx.supabaseAdmin);
    return await work();
  } catch (cause) {
    if (cause instanceof TRPCError) throw cause;
    const code = cause instanceof PublishMonitorError ? cause.code : 'PUBLISH_MONITOR_UNAVAILABLE';
    throw new TRPCError({ code: code === 'PUBLISH_MONITOR_UNAVAILABLE' ? 'INTERNAL_SERVER_ERROR' : 'FORBIDDEN',
      message: code, cause });
  }
}

export const publishMonitorRouter = router({
  settings: protectedProcedure.query(({ ctx }) =>
    safe(ctx, () => readPublishMonitorSettings(ctx.supabaseAdmin, ctx.profileId))),
  // Weekly automatic review is a Gold entitlement (Master Plan §2.1 item 51); turning it off is always allowed,
  // even while the feature is paused, so a paused opt-in cannot come back on (and spend credits) by itself.
  setAutoReview: protectedProcedure.input(autoReviewInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    if (input.enabled) {
      const entitlements = await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId);
      if (!entitlements.allowWeeklyAutoReview) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
      }
    }
    return setAutoReview(ctx.supabaseAdmin, ctx.profileId, input);
  }, input.enabled)),
  connections: protectedProcedure.query(({ ctx }) =>
    safe(ctx, () => listConnections(ctx.supabaseAdmin, ctx.profileId))),
});
