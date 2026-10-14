/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { newWorkGate } from '../runtime/newWorkGate';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { fusionExecutor } from './executor';
import { reviewFlow } from './review';
import { ENDED_STATES } from './reviewRecord';

/** FUSION-BACKGROUND (Owner 2026-10-15 "现在就做。"): a review advances on the server, one step per function
 * invocation, so the user may leave the page. Each invocation takes the review's advance lease (0258), runs one
 * continue (re-judge, decide, claim) and dispatches that step's calls in parallel, then relays to a fresh invocation.
 * Billing is unchanged: the same claims (frozen caps, group admission), the same dispatchOnce and settlement. */

/** A lease outlives the longest step (one invocation is at most 300 s on Vercel Hobby). */
const LEASE_TTL = '5 minutes';
/** Every lease grant counts; past this the review is never advanced automatically again and an alert is logged
 * (a relay bug must not call itself forever). Round 1, round 2 and the summary, each with up to 3 attempts, need at
 * most 3 × 3 + 1 grants per run; the rest covers user returns and daily kicks. */
export const MAX_ADVANCES = 30;
/** One relay chain: at most this many hops before it stops for the backstops (3 phases × 3 attempts + the finish). */
export const MAX_HOPS = 10;

export type AdvanceResult = { next: boolean; reason: string; dispatched?: number };

/** The service-side flow: billed as the review's own user, exactly as the daily recovery settles (no user token on
 * the server). Admission still checks the switch, membership, allowlist and frozen caps on every claim. */
export function serviceReviewFlow(admin: SupabaseClient, actorId: string, budget: RuntimeBudget,
  env: Record<string, string | undefined> = process.env) {
  const executor = {
    async run(...args: Parameters<ReturnType<typeof fusionExecutor>['run']>) {
      const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env);
      const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => actorId,
        adapter: stagingTransport(admin, window, budget), budget });
      return fusionExecutor({ billing, admin, actorId, callGate: newWorkGate(admin, 'staging').calls, budget }).run(...args);
    },
  };
  return reviewFlow({ admin, actorId, env, executor: executor as ReturnType<typeof fusionExecutor> });
}

const leaseResult = z.object({ acquired: z.boolean(), reason: z.string(), actorId: z.string().uuid().optional(),
  count: z.number().optional() }).passthrough();
export type Lease = z.infer<typeof leaseResult>;

/** Runs work under the review's advance lease (0258), or returns the refusal without running it. Every advancer
 * (the relay, an old page still calling dispatch) goes through here, so two never work on one review at once. */
export async function withAdvanceLease<T>(admin: SupabaseClient, reviewId: string, work: (lease: Lease) => Promise<T>):
  Promise<{ ran: true; value: T } | { ran: false; reason: string }> {
  const token = randomUUID();
  const leased = await admin.rpc('fusion_review_advance_lease', { p_review_id: reviewId, p_token: token, p_ttl: LEASE_TTL,
    p_max: MAX_ADVANCES });
  if (leased.error) return { ran: false, reason: 'lease_unavailable' };
  const lease = leaseResult.parse(leased.data);
  if (!lease.acquired) {
    if (lease.reason === 'limit') logger.error('billing', 'fusion_review_advance_limit', { reviewId, count: lease.count });
    return { ran: false, reason: lease.reason };
  }
  try { return { ran: true, value: await work(lease) }; }
  finally { await admin.rpc('fusion_review_advance_release', { p_review_id: reviewId, p_token: token }); }
}

/** One step of one review. Never throws for an expected stop; the caller relays only when next is true. */
export async function advanceReview(input: { admin: SupabaseClient; reviewId: string; env?: Record<string, string | undefined>;
  budget?: RuntimeBudget; flow?: (actorId: string, budget: RuntimeBudget) => ReturnType<typeof reviewFlow> }): Promise<AdvanceResult> {
  const { admin, reviewId } = input;
  const outcome = await withAdvanceLease(admin, reviewId, async lease => {
    const budget = input.budget ?? createRuntimeBudget();
    const flow = input.flow ? input.flow(lease.actorId!, budget) : serviceReviewFlow(admin, lease.actorId!, budget, input.env);
    try {
      const step = await flow.continue(reviewId);
      if (ENDED_STATES.has(step.review.state)) return { next: false, reason: 'ended' };
      if (step.waiting === 'credits') return { next: false, reason: 'waiting_credits' };
      // Calls already dispatched elsewhere (an invocation that was cut off) settle through the recovery, never twice.
      const calls = step.calls.filter(call => !call.dispatched);
      if (!calls.length) return { next: false, reason: step.waiting === 'calls' ? 'in_flight' : 'idle' };
      const results = await Promise.allSettled(calls.map(call => flow.dispatch(reviewId, call.callId)));
      const failed = results.filter(result => result.status === 'rejected').length;
      if (failed) logger.warn('billing', 'fusion_review_dispatch_failed', { reviewId, failed });
      // Relay even after a failed dispatch: the next continue claims an undispatched call again (§2.1 补领, bounded).
      return { next: true, reason: 'advanced', dispatched: calls.length - failed };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNEXPECTED';
      logger.warn('billing', 'fusion_review_advance_failed', { reviewId, code });
      return { next: false, reason: 'failed' };
    }
  });
  return outcome.ran ? outcome.value : { next: false, reason: outcome.reason };
}

const uuid = z.string().uuid();
/** The internal relay request: only a review id and the hop number. */
export const advanceRequest = z.object({ reviewId: uuid, hop: z.number().int().min(0).max(MAX_HOPS) }).strict();

/** Constant-time comparison of the bearer secret; a missing secret refuses everything. */
export function advanceAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Asks the internal endpoint to advance a review in a fresh invocation. It answers at once (the step runs after
 * the response), so this waits only for the acceptance. Failures are logged; the backstops pick the review up. */
export async function kickAdvance(origin: string, reviewId: string, hop = 0,
  env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<boolean> {
  const secret = env.CRON_SECRET;
  if (!secret || hop > MAX_HOPS) return false;
  try {
    const response = await fetcher(new URL('/api/fusion/advance', origin), { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(advanceRequest.parse({ reviewId, hop })), signal: AbortSignal.timeout(10_000) });
    if (response.status !== 202) logger.warn('billing', 'fusion_review_kick_refused', { reviewId, status: response.status });
    return response.status === 202;
  } catch {
    logger.warn('billing', 'fusion_review_kick_failed', { reviewId });
    return false;
  }
}

/** Daily backstop: kicks reviews that stopped moving (each at most once a day, 0258), within a time limit. */
export async function kickStalledReviews(admin: SupabaseClient, origin: string, options: { timeLimitMs?: number;
  now?: () => number; kick?: typeof kickAdvance } = {}) {
  const now = options.now ?? Date.now;
  const stopAt = now() + (options.timeLimitMs ?? 15_000);
  const listed = await admin.rpc('fusion_review_kick_stalled', { p_idle: '10 minutes', p_limit: 20 });
  if (listed.error) return { success: false, kicked: 0 };
  const ids = z.array(z.object({ review_id: uuid })).parse(listed.data).map(row => row.review_id);
  let kicked = 0;
  for (const id of ids) {
    if (now() >= stopAt) break;
    if (await (options.kick ?? kickAdvance)(origin, id, 0)) kicked++;
  }
  return { success: true, kicked, listed: ids.length };
}
