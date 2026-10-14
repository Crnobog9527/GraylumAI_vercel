/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import {
  autoReviewInput, listConnections, readPublishMonitorSettings, setAutoReview,
} from '../services/publishMonitor/foundation';
import { publishMonitorConnectRouter } from './publishMonitorConnect';
import { guarded as safe } from './publishMonitorGuard';

/** PUBLISH-MONITOR: a user reads and changes only their own monitoring state; off until enabled by admin. */

export const publishMonitorRouter = router({
  settings: protectedProcedure.query(({ ctx }) =>
    safe(ctx, () => readPublishMonitorSettings(ctx.supabaseAdmin, ctx.profileId))),
  // Weekly automatic review is a Gold entitlement (Master Plan §2.1 item 51); turning it off is always allowed.
  setAutoReview: protectedProcedure.input(autoReviewInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    if (input.enabled) {
      const entitlements = await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId);
      if (!entitlements.allowWeeklyAutoReview) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
      }
    }
    return setAutoReview(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  connections: protectedProcedure.query(({ ctx }) =>
    safe(ctx, () => listConnections(ctx.supabaseAdmin, ctx.profileId))),
  connect: publishMonitorConnectRouter,
});
