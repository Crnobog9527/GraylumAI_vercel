/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { withPlatformSecretRequest } from '../platformSecrets/request';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { readTurnRouteEnv } from '../../lib/envValidator';
import { swallow } from '../../lib/swallow';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { newWorkGate, type RuntimeCallGate } from '../runtime/newWorkGate';
import { runtimeGateEnvironment } from '../runtime/realHost';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { fusionExecutor } from './executor';
import { reviewFlow } from './review';
import { ENDED_STATES, reviewRecord } from './reviewRecord';
import { turnClients } from '../turn/db';
import { juryTurn } from '../turn/jury';
import { redisCounterStore, type CounterStore } from '../turn/limiter';

/** FUSION-BACKGROUND (Owner 2026-10-15 "现在就做。"): a review advances on the server, one step per function
 * invocation, so the user may leave the page. Each invocation takes the review's advance lease (0258), runs one
 * continue (re-judge, decide, claim) and dispatches that step's calls in parallel, then relays to a fresh invocation.
 * Billing is unchanged: the same claims (frozen caps, group admission), the same dispatchOnce and settlement. */

/** A lease outlives the longest step (one invocation is at most 300 s on Vercel Hobby). */
const LEASE_TTL = '5 minutes';
/** Work attempts count (expected no-work stops are refunded on release); past this the review is never advanced automatically again and an alert is logged
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
      return fusionExecutor({ billing, admin, actorId, callGate: newWorkGate(admin, runtimeGateEnvironment(window)).calls, budget })
        .run(...args);
    },
  };
  return reviewFlow({ admin, actorId, env, executor: executor as ReturnType<typeof fusionExecutor> });
}

const leaseResult = z.object({ acquired: z.boolean(), reason: z.string(), actorId: z.string().uuid().optional(),
  count: z.number().optional() }).passthrough();
export type Lease = z.infer<typeof leaseResult>;

/** Runs work under the review's advance lease (0258), or returns the refusal without running it. Every advancer
 * (the relay, an old page still calling dispatch) goes through here, so two never work on one review at once. */
export async function withAdvanceLease<T>(admin: SupabaseClient, reviewId: string, work: (lease: Lease) => Promise<T>,
  refund: (value: T) => boolean = () => false):
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
  let unspent = false;
  try {
    const value = await work(lease);
    unspent = refund(value);
    return { ran: true, value };
  } finally {
    await admin.rpc('fusion_review_advance_release', { p_review_id: reviewId, p_token: token, p_refund: unspent });
  }
}

/** One step of one review. Never throws for an expected stop; the caller relays only when next is true. */
export async function advanceReview(input: { admin: SupabaseClient; reviewId: string; env?: Record<string, string | undefined>;
  budget?: RuntimeBudget; flow?: (actorId: string, budget: RuntimeBudget) => ReturnType<typeof reviewFlow>;
  /** CORE-PATH-V2 V2-7b: the jury turn's dependencies for a review on the turn path (tests inject them). */
  jury?: { slots?: CounterStore; transport?: typeof fetch; calls?: RuntimeCallGate } }): Promise<AdvanceResult> {
  return withPlatformSecretRequest(async () => {
    const { admin, reviewId } = input;
    const outcome = await withAdvanceLease(admin, reviewId, async lease => {
      // A review on the turn path advances through its jury turn (one group per invocation), never through BILL2.
      const view = await swallow('fusion_review_read_failed', reviewRecord(admin, lease.actorId!).read(reviewId), null,
        { category: 'billing', reviewId });
      if (view?.turnId) {
        try {
          // The call gate of the turn path: the same namespace as POST /api/turn (no test window on the turn path).
          return await juryTurn({ admin, clients: turnClients(admin), slots: input.jury?.slots ?? redisCounterStore(),
            transport: input.jury?.transport, calls: input.jury?.calls ?? newWorkGate(admin, readTurnRouteEnv().environment).calls },
          lease.actorId!).advance(reviewId);
        } catch (error) {
          const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNEXPECTED';
          logger.warn('billing', 'fusion_review_advance_failed', { reviewId, code });
          return { next: false, reason: 'failed' };
        }
      }
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
        const dispatched = results.filter(result => result.status === 'fulfilled'
          && (result.value.state === 'judged'
            || !['not_started', 'not_dispatched'].includes(result.value.reason))).length;
        // No accepted dispatch: stop this chain and refund the attempt so a later retry can recover from an outage.
        if (!dispatched) return { next: false, reason: 'failed', dispatched: 0 };
        // Partial progress may continue; dispatchOnce still prevents resending accepted calls.
        return { next: true, reason: 'advanced', dispatched };
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNEXPECTED';
        logger.warn('billing', 'fusion_review_advance_failed', { reviewId, code });
        return { next: false, reason: 'failed' };
      }
    }, value => ['waiting_credits', 'in_flight', 'idle', 'ended', 'failed', 'gated'].includes(value.reason));
    return outcome.ran ? outcome.value : { next: false, reason: outcome.reason };
  });
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
  env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<boolean> {
  const secret = env.CRON_SECRET;
  if (!secret || hop > MAX_HOPS) return false;
  try {
    const target = new URL(origin);
    const configured = [env.NEXT_PUBLIC_APP_URL, env.VERCEL_URL && `https://${env.VERCEL_URL}`];
    const trusted = configured.some(value => {
      if (!value) return false;
      try { return new URL(value).origin === target.origin; } catch { return false; }
    });
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (!trusted || target.username || target.password
      || (target.protocol !== 'https:' && !(local && target.protocol === 'http:'))) return false;
    const response = await fetcher(new URL('/api/fusion/advance', target), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(advanceRequest.parse({ reviewId, hop })), signal: AbortSignal.timeout(timeoutMs) });
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
  const rows = z.array(z.object({ review_id: uuid, kicked_at: z.string() })).parse(listed.data);
  let kicked = 0;
  let success = true;
  for (const row of rows) {
    let accepted = false;
    try {
      if (now() < stopAt) accepted = await (options.kick ?? kickAdvance)(origin, row.review_id, 0, process.env, fetch, Math.max(1, stopAt - now()));
    } catch { /* Restore the reservation below, including a failed custom transport. */ }
    if (accepted) { kicked++; continue; }
    success = false;
    // Compare the reservation timestamp: never erase a newer cron's successful kick marker.
    const cleared = await admin.rpc('fusion_review_kick_reset',
      { p_review_id: row.review_id, p_kicked_at: row.kicked_at });
    if (cleared.error) logger.warn('billing', 'fusion_review_kick_reset_failed', { reviewId: row.review_id });
  }
  return { success, kicked, listed: rows.length };
}
