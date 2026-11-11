/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { assertPublishMonitorEnabled } from '../services/publishMonitor/foundation';
import { cancelScheduled, listSchedule, rescheduleScheduled } from '../services/publishMonitor/schedule';
import { requirePostForMeDeps } from '../services/publishMonitor/secrets';
import { guarded } from './publishMonitorGuard';
import { limitStep, requirePublishEntitlement } from './publishMonitorPublish';

/**
 * PUBLISH-SCHEDULE: the schedule page. Scheduling itself is the publish submit with `scheduledAt`. Reading one's own
 * schedule and cancelling stay possible while the feature is paused or the plan lapsed (they only return held
 * credits); moving a post needs both, like a new publish.
 */
const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const rangeInput = z.object({ from: instant, to: instant }).strict();
const cancelInput = z.object({ jobId: uuid, expectedAt: instant }).strict();
const rescheduleInput = z.object({ jobId: uuid, expectedAt: instant, newAt: instant }).strict();

export const publishMonitorScheduleRouter = router({
  list: protectedProcedure.input(rangeInput).query(({ ctx, input }) =>
    guarded(ctx, () => listSchedule(ctx.supabaseAdmin, ctx.profileId, input.from, input.to), false)),
  cancel: protectedProcedure.input(cancelInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    await limitStep('schedule-change', ctx.profileId);
    return cancelScheduled(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId, input.jobId,
      input.expectedAt);
  }, false)),
  reschedule: protectedProcedure.input(rescheduleInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    await assertPublishMonitorEnabled(ctx.supabaseAdmin);
    await requirePublishEntitlement(ctx);
    await limitStep('schedule-change', ctx.profileId);
    return rescheduleScheduled(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId,
      input.jobId, input.expectedAt, input.newAt);
  }, false)),
});
