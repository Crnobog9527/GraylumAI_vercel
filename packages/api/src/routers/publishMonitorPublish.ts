/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import {
  createMediaUploads, MAX_MEDIA, publishInput, readPublishJob, refreshPublishJob, submitPublish,
} from '../services/publishMonitor/publish';
import { takeUploadSlots } from '../services/publishMonitor/postForMe/config';
import { assertPublishPlatformsOpen, readPublishOptions } from '../services/publishMonitor/publishOptions';
import { requirePostForMeDeps } from '../services/publishMonitor/secrets';
import { RateLimitError } from '../lib/rateLimitError';
import { guarded } from './publishMonitorGuard';

/**
 * PUBLISH-MONITOR PR-5 (plan §2.1, §6): one-click publishing for Pro and Gold. Every step is checked on the server:
 * the entitlement here, targets, consent, slots and credits in the database. Uploads are requested only after the
 * user confirmed that the files go to a third-party service on a public link (the input must say so).
 */
const uuid = z.string().uuid();
// One request returns every upload slot a post needs, so a complete post fits the per-user step allowance. The targets
// come along so nothing is uploaded for a platform that is not open for publishing.
const uploadInput = z.object({ disclosureAccepted: z.literal(true), count: z.number().int().min(1).max(MAX_MEDIA),
  connectionIds: z.array(uuid).min(1).max(9) }).strict();
const jobInput = z.object({ jobId: uuid }).strict();
// Each step reads from the site-wide Post for Me budget; one user gets a small allowance per step (5 per 5 minutes).
const limitStep = (step: string, profileId: string) => checkRateLimitOrThrow(`publish-monitor-${step}:${profileId}`, 'auth');

async function requirePublishEntitlement(ctx: { supabaseAdmin: Parameters<typeof readMembershipEntitlements>[0];
  profileId: string }) {
  const entitlements = await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId);
  if (!entitlements.allowPublish) throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
}

export const publishMonitorPublishRouter = router({
  // Which platforms are open for publishing and the most a publish to n targets can hold (no provider call).
  options: protectedProcedure.query(({ ctx }) => guarded(ctx, async () => {
    await requirePublishEntitlement(ctx);
    return readPublishOptions(ctx.supabaseAdmin);
  })),
  uploadUrl: protectedProcedure.input(uploadInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    await requirePublishEntitlement(ctx);
    await assertPublishPlatformsOpen(ctx.supabaseAdmin, ctx.profileId, input.connectionIds);
    await limitStep('upload', ctx.profileId);
    // Weighted by the number of slots, so parallel or split requests cannot exceed the per-user upload allowance.
    const slots = await takeUploadSlots(ctx.profileId, input.count);
    if (!slots.ok) throw new RateLimitError('rate_limited', slots.retryAfterSeconds);
    return createMediaUploads(await requirePostForMeDeps(ctx.supabaseAdmin), input.count);
  })),
  submit: protectedProcedure.input(publishInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    await requirePublishEntitlement(ctx);
    await assertPublishPlatformsOpen(ctx.supabaseAdmin, ctx.profileId, input.connectionIds);
    await limitStep('publish', ctx.profileId);
    return submitPublish(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId, input);
  })),
  // Reading one's own job stays possible while the feature is paused: credits may still be held by it.
  job: protectedProcedure.input(jobInput).query(({ ctx, input }) =>
    guarded(ctx, () => readPublishJob(ctx.supabaseAdmin, ctx.profileId, input.jobId), false)),
  refresh: protectedProcedure.input(jobInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    await limitStep('publish-refresh', ctx.profileId);
    return refreshPublishJob(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId, input.jobId);
  }, false)),
});
