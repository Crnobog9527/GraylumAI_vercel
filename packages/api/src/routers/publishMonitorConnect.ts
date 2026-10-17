/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { readMembershipEntitlements } from '../services/membershipEntitlements';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import {
  cancelConnect, confirmConnect, readPending, recordCallback, startConnect,
} from '../services/publishMonitor/connect';
import {
  assertBound, cleanupUnselected, describeCandidates, disconnectTakenOver,
} from '../services/publishMonitor/connectFlow';
import { requirePostForMeDeps } from '../services/publishMonitor/secrets';
import { guarded } from './publishMonitorGuard';

/**
 * PUBLISH-MONITOR PR-2b-2 (plan §4.1): connect one of the user's own brand accounts through Post for Me.
 * Start sets an httpOnly cookie (in the web route); every later step must come from that same browser.
 */
const uuid = z.string().uuid();
const requestInput = z.object({ requestId: uuid }).strict();
const startInput = z.object({
  accountProjectId: uuid,
  publish: z.boolean().default(false),
  connectionType: z.enum(['organization', 'instagram', 'facebook']).optional(),
  bluesky: z.object({ handle: z.string().max(253), appPassword: z.string().max(19) }).strict().optional(),
}).strict();
// One consent rarely imports more than a few pages; more hints are ignored (the daily sweep settles the rest).
export const MAX_CALLBACK_HINTS = 20;
const callbackInput = z.object({ requestId: uuid, accountIds: z.array(z.string().max(128)).max(200) }).strict();
const confirmInput = z.object({ requestId: uuid, providerAccountId: z.string().max(128), autoTrack: z.boolean() }).strict();

type Ctx = { headers: Headers; profileId: string; supabaseAdmin: Parameters<typeof readPending>[0] };
const cookieOf = (ctx: Ctx) => ctx.headers.get('cookie');
// Every step after start reads from the site-wide Post for Me budget; each user gets a small allowance per step
// (5 per 5 minutes), checked before any provider call so replays cannot drain the budget for everyone.
const limitStep = (step: string, profileId: string) => checkRateLimitOrThrow(`publish-monitor-${step}:${profileId}`, 'auth');

export const publishMonitorConnectRouter = router({
  // Reading one's own data needs a data window (Pro/Gold); adding publishing needs the publish entitlement.
  start: protectedProcedure.input(startInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    const entitlements = await readMembershipEntitlements(ctx.supabaseAdmin, ctx.profileId);
    if (entitlements.ownDataWindowDays <= 0 || (input.publish && !entitlements.allowPublish)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    }
    // Each start costs a call from the site-wide provider budget; one user cannot drain it.
    await limitStep('connect', ctx.profileId);
    return startConnect(ctx.supabaseAdmin, await requirePostForMeDeps(ctx.supabaseAdmin), ctx.profileId, input);
  })),
  callback: protectedProcedure.input(callbackInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    assertBound(cookieOf(ctx), input.requestId);
    await limitStep('callback', ctx.profileId);
    const deps = await requirePostForMeDeps(ctx.supabaseAdmin);
    const result = await recordCallback(ctx.supabaseAdmin, deps, ctx.profileId, input.requestId,
      input.accountIds.slice(0, MAX_CALLBACK_HINTS));
    await disconnectTakenOver(deps, result.takenOver);
    return { requestId: result.requestId, offered: result.newAccounts.length + result.ownExisting.length,
      takenOver: result.quarantined.length };
  })),
  pending: protectedProcedure.input(requestInput).query(({ ctx, input }) => guarded(ctx, async () => {
    assertBound(cookieOf(ctx), input.requestId);
    await limitStep('page', ctx.profileId);
    const pending = await readPending(ctx.supabaseAdmin, ctx.profileId, input.requestId);
    return { ...pending, candidates: await describeCandidates(await requirePostForMeDeps(ctx.supabaseAdmin), pending) };
  })),
  confirm: protectedProcedure.input(confirmInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    assertBound(cookieOf(ctx), input.requestId);
    await limitStep('decide', ctx.profileId);
    const deps = await requirePostForMeDeps(ctx.supabaseAdmin);
    const result = await confirmConnect(ctx.supabaseAdmin, deps, ctx.profileId, input.requestId,
      input.providerAccountId, input.autoTrack);
    const cleanup = await cleanupUnselected(deps, result.externalId, result.unselected);
    return { connectionId: result.connectionId, cleanupPending: cleanup.deferred.length > 0 };
  })),
  cancel: protectedProcedure.input(requestInput).mutation(({ ctx, input }) => guarded(ctx, async () => {
    assertBound(cookieOf(ctx), input.requestId);
    await limitStep('decide', ctx.profileId);
    // Built before the attempt becomes final, so a missing provider key cannot fail an already-applied cancel.
    const deps = await requirePostForMeDeps(ctx.supabaseAdmin);
    const result = await cancelConnect(ctx.supabaseAdmin, ctx.profileId, input.requestId);
    const cleanup = await cleanupUnselected(deps, result.externalId, result.unselected);
    return { cancelled: true as const, cleanupPending: cleanup.deferred.length > 0 };
  })),
});
