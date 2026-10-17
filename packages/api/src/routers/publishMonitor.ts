/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import {
  autoReviewInput, disconnectConnection, disconnectInput, listConnections, readPublishMonitorSettings, setAutoReview,
} from '../services/publishMonitor/foundation';
import {
  dataInput, historyInput, linkInput, linkPost, manualRefresh, readData, readPostHistory, refreshInput,
} from '../services/publishMonitor/data';
import { importManualRows, manualImportInput } from '../services/publishMonitor/manualImport';
import { requirePostForMeDeps } from '../services/publishMonitor/secrets';
import {
  addBenchmark, benchmarkAddInput, connectOwnTikhub, tikhubConnectInput,
} from '../services/publishMonitor/tikhub';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import { publishMonitorConnectRouter } from './publishMonitorConnect';
import { guarded as safe } from './publishMonitorGuard';

/** PUBLISH-MONITOR: a user reads and changes only their own monitoring state; off until enabled by admin. */

type Ctx = { profileId: string; supabaseAdmin: Parameters<typeof readMembershipEntitlements>[0] };
/** The data window always comes from the server-side entitlement (plan §9 item 4); free accounts have none. */
async function dataWindow(ctx: Ctx): Promise<number> {
  const days = (await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId)).ownDataWindowDays;
  if (days <= 0) throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
  return days;
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
  // Always allowed, even while the feature is paused: a user can always remove their data.
  disconnect: protectedProcedure.input(disconnectInput).mutation(({ ctx, input }) =>
    safe(ctx, () => disconnectConnection(ctx.supabaseAdmin, ctx.profileId, input), false)),
  // PR-3a: the user's own posts and daily snapshots inside their plan's window (Pro 30 days, Gold 90).
  data: protectedProcedure.input(dataInput).query(({ ctx, input }) =>
    safe(ctx, async () => readData(ctx.supabaseAdmin, ctx.profileId, await dataWindow(ctx), input))),
  postHistory: protectedProcedure.input(historyInput).query(({ ctx, input }) =>
    safe(ctx, async () => readPostHistory(ctx.supabaseAdmin, ctx.profileId, await dataWindow(ctx), input))),
  linkPost: protectedProcedure.input(linkInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    await dataWindow(ctx);
    return linkPost(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  // Once an hour per connection (enforced in the database); reading one's own data is free (Owner 2026-10-13).
  refresh: protectedProcedure.input(refreshInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    const days = await dataWindow(ctx);
    return manualRefresh(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId, days, input);
  })),
  // PR-3b: rows the user confirmed from a table export or typed next to a post link (Pro/Gold, plan §11 item 5).
  manualImport: protectedProcedure.input(manualImportInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    await dataWindow(ctx);
    await checkRateLimitOrThrow(`publish-monitor-import:${ctx.profileId}`, 'api');
    return importManualRows(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  // PR-4a: own Xiaohongshu/Douyin accounts by public profile link (Pro/Gold), and Gold benchmark accounts. Connecting
  // is free; the daily TikHub read (billed per call) arrives with PR-4b. Removing either uses `disconnect`.
  connectTikhub: protectedProcedure.input(tikhubConnectInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    await dataWindow(ctx);
    return connectOwnTikhub(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  addBenchmark: protectedProcedure.input(benchmarkAddInput).mutation(({ ctx, input }) => safe(ctx, async () => {
    if (!(await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId)).allowBenchmarkMonitor) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    }
    await checkRateLimitOrThrow(`publish-monitor-benchmark:${ctx.profileId}`, 'api');
    return addBenchmark(ctx.supabaseAdmin, ctx.profileId, input);
  })),
  connect: publishMonitorConnectRouter,
});
