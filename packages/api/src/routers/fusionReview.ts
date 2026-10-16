/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeBudget } from '../services/runtime/budget';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { authoritativeBilling, type BillingRpc } from '../services/bill2/service';
import { createRuntimeBudget } from '../services/runtime/budget';
import { newWorkGate } from '../services/runtime/newWorkGate';
import { runtimeActor } from '../services/runtime/actor';
import { loadStagingPolicy } from '../services/runtime/stagingPolicy';
import { stagingTransport } from '../services/runtime/stagingTransport';
import { StagingAccessError, stagingProcedureError } from '../services/runtime/stagingErrors';
import { reportRevisionService } from '../services/report/revisionSync';
import { fusionExecutor } from '../services/fusion/executor';
import { reviewFlow } from '../services/fusion/review';
import { advanceReview, kickAdvance, withAdvanceLease } from '../services/fusion/background';
import { ENDED_STATES, reviewState } from '../services/fusion/reviewRecord';
import { adoptionChoices } from '../services/fusion/reviewAdoption';
import { readFusionSettings, PANEL_SEATS } from '../services/fusion/settings';

const uuid = z.string().uuid();
const forbidden = new Set(['FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED', 'FUSION_REVIEW_BREAKER']);
const conflict = new Set(['FUSION_REVIEW_ACTIVE', 'FUSION_REVIEW_ENDED', 'FUSION_REVIEW_STEP_CONFLICT', 'FUSION_REVIEW_STALE',
  'FUSION_REVIEW_ADOPTED', 'FUSION_ADOPTION_STALE', 'REPORT_REVISION_STALE', 'REPORT_SOURCE_CONFLICT', 'REPORT_REVISION_DECIDED',
  'FUSION_REVIEW_VERSION_BLOCKED', 'FUSION_REVIEW_CONFLICT']);
/** Exact Fusion refusals keep their code for the page; anything else goes through the staging error mapping. */
function reviewError(cause: unknown, path: string): TRPCError {
  const message = cause instanceof Error ? cause.message : '';
  if (/^(FUSION|REPORT)_[A-Z_]+$/.test(message)) {
    return new TRPCError({ code: forbidden.has(message) ? 'FORBIDDEN' : conflict.has(message) ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
  return stagingProcedureError(cause, path);
}

/** The R14 calls the review flow uses (propose, apply, decline), with the user's own client. One helper for both
 * middlewares so they cannot drift apart (#962 review: the reader had lost decline). */
export function revisionHooks(revisions: Pick<ReturnType<typeof reportRevisionService>, 'propose' | 'apply' | 'decline'>) {
  return {
    propose: async (input: unknown) => {
      const r = await revisions.propose(input);
      return { revisionId: r.revisionId, diffHash: r.diffHash, diff: r.diff };
    },
    apply: async (input: unknown) => ({ versionId: (await revisions.apply(input)).versionId }),
    decline: (input: unknown) => revisions.decline(input),
  };
}

/** What the live flow needs from the protected context. */
type ProtectedCtx = { hasSupabaseAdminPrivileges?: boolean; supabaseAdmin?: SupabaseClient | null; user: { id: string };
  userScopedSupabase: SupabaseClient; runtimeBudget?: RuntimeBudget; headers?: Headers | null };
/** The live review flow: staging test window, billing, executor and call gate (one request per model call). */
async function liveFlow(ctx: ProtectedCtx) {
  if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  const admin = ctx.supabaseAdmin;
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, ctx.user.id, process.env);
  const budget = ctx.runtimeBudget ?? createRuntimeBudget();
  const actor = runtimeActor(ctx.userScopedSupabase.auth, ctx.user.id, budget, ctx.headers?.get('Authorization'));
  const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor, adapter: stagingTransport(admin, window, budget), budget });
  const executor = fusionExecutor({ billing, admin, actorId: ctx.user.id, callGate: newWorkGate(admin, 'staging').calls, budget });
  return reviewFlow({ admin, actorId: ctx.user.id, executor, ...revisionHooks(reportRevisionService(ctx.userScopedSupabase, admin)) });
}
const unwrap = (cause: unknown, path: string) => reviewError(cause instanceof TRPCError && cause.cause ? cause.cause : cause, path);

/** FUSION-REVIEW review API (staging test window only, like Runtime real calls). One request per model call. */
const procedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    const result = await next({ ctx: { ...ctx, flow: await liveFlow(ctx) } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw unwrap(cause, path); }
});
const review = z.object({ reviewId: uuid }).strict();

/** Reads only (events, panel names): no staging window, executor or billing is needed to look. */
const reader = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const flow = reviewFlow({ admin: ctx.supabaseAdmin, actorId: ctx.user.id,
      ...revisionHooks(reportRevisionService(ctx.userScopedSupabase, ctx.supabaseAdmin)) });
    const result = await next({ ctx: { ...ctx, admin: ctx.supabaseAdmin, flow } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw reviewError(cause instanceof TRPCError && cause.cause ? cause.cause : cause, path); }
});

/** Hands a review to the server (FUSION-BACKGROUND, Owner 2026-10-15): after the response, a fresh invocation
 * advances it step by step, so the user may leave. Without the relay (no server secret, a local run) one step runs
 * here after the response instead; the page's next read hands it over again. */
function handToServer(ctx: { scheduleAfter?: (task: () => Promise<unknown>) => void; origin?: string;
  supabaseAdmin?: SupabaseClient | null }, reviewId: string) {
  const admin = ctx.supabaseAdmin, origin = ctx.origin;
  if (!ctx.scheduleAfter || !admin) return;
  ctx.scheduleAfter(async () => {
    if (origin && await kickAdvance(origin, reviewId)) return;
    await advanceReview({ admin, reviewId });
  });
}

const mineCursor = z.object({ createdAt: z.string().datetime({ offset: true }), reviewId: uuid }).strict();
const mineInput = z.object({ limit: z.number().int().min(1).max(50).default(10), draftId: uuid.optional(),
  cursor: mineCursor.optional() }).strict();
const mineOutput = z.array(z.object({ reviewId: uuid, draftId: uuid, sourceVersionId: uuid, state: reviewState,
  round: z.number().int().min(1), phase: z.enum(['review', 'summary']), outcomeKind: z.string().nullable(),
  awaitingChoice: z.boolean(), createdAt: z.string(), endedAt: z.string().nullable(), seenAt: z.string().nullable() }));
const startInput = z.object({ requestId: uuid, draftId: uuid, sourceVersionId: uuid }).strict();
/** A retried start finds its review before the live-call window is required (#962 review); a new start needs it. */
const startProcedure = protectedProcedure.input(startInput).use(async ({ ctx, input, next, path }) => {
  if (ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin) {
    try {
      const existing = await reviewFlow({ admin: ctx.supabaseAdmin, actorId: ctx.user.id }).replayStart(input);
      if (existing) return next({ ctx: { ...ctx, replayed: existing } });
    } catch (cause) { throw unwrap(cause, path); }
  }
  return next({ ctx: { ...ctx, replayed: null } });
});

export const fusionReviewRouter = router({
  start: startProcedure.mutation(async ({ ctx, input, path }) => {
    const started = ctx.replayed ?? await (async () => {
      try { return await (await liveFlow(ctx)).start(input); } catch (cause) { throw unwrap(cause, path); }
    })();
    if (!ENDED_STATES.has(started.state)) handToServer(ctx, started.reviewId);
    return started;
  }),
  /** The page only reads now (FUSION-BACKGROUND): returns the review as it stands and hands it to the server again
   * (a no-op while the server holds it). No call is claimed or returned for the page to dispatch. */
  continue: reader.input(review).mutation(async ({ ctx, input }) => {
    const view = await ctx.flow.read(input.reviewId);
    if (!ENDED_STATES.has(view.state)) handToServer(ctx, input.reviewId);
    return { review: view, calls: [] as typeof view.calls, background: true as const };
  }),
  /** Kept for old pages: runs only under the advance lease, so it never races the server; refused calmly otherwise. */
  dispatch: procedure.input(review.extend({ callId: uuid })).mutation(async ({ ctx, input }) => {
    const leased = await withAdvanceLease(ctx.supabaseAdmin, input.reviewId, () => ctx.flow.dispatch(input.reviewId, input.callId));
    return leased.ran ? leased.value : { skipped: true as const, reason: leased.reason };
  }),
  /** The completion notice (FUSION-BACKGROUND): the user's latest reviews, "待选择" / "已暂停" and whether seen. */
  mine: reader.input(mineInput).output(mineOutput).query(async ({ ctx, input }) => {
    const result = await ctx.admin.rpc('fusion_review_mine', { p_actor_id: ctx.user.id, p_limit: input.limit,
      p_draft_id: input.draftId ?? null, p_before_created_at: input.cursor?.createdAt ?? null,
      p_before_id: input.cursor?.reviewId ?? null });
    if (result.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    return mineOutput.parse(result.data);
  }),
  markSeen: reader.input(review).mutation(async ({ ctx, input }) => {
    const result = await ctx.admin.rpc('fusion_review_mark_seen', { p_actor_id: ctx.user.id, p_review_id: input.reviewId });
    if (result.error) throw new Error(result.error.message === 'FUSION_REVIEW_DENIED' ? 'FUSION_REVIEW_DENIED' : 'FUSION_REVIEW_UNAVAILABLE');
    return { seen: true };
  }),
  // Closing only cancels and releases in the database: it must work even after the staging call window is
  // closed or switched off, so a user can always stop and free the review slot (#962 review).
  stop: reader.input(review).mutation(({ ctx, input }) => ctx.flow.stop(input.reviewId)),
  end: reader.input(review).mutation(({ ctx, input }) => ctx.flow.end(input.reviewId)),
  /** Progress events for the animation (FUSION-REVIEW §2.2a); clients play the ids they have not seen. */
  events: reader.input(review).query(({ ctx, input }) => ctx.flow.events(input.reviewId)),
  /** Per-section adoption (Owner 2026-10-14): R14 propose + apply only, no model call, so no staging call window is needed. */
  adopt: reader.input(review.extend({ requestId: uuid, choices: adoptionChoices })).mutation(({ ctx, input }) => ctx.flow.adopt(input)),
  /** Step 2 after the user saw the R14 diff and cascade: apply (new formal version) or decline (nothing changes). */
  confirmAdoption: reader.input(review.extend({ requestId: uuid, choices: adoptionChoices,
    expectedDiffHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['apply', 'decline']) }))
    .mutation(({ ctx, input }) => ctx.flow.confirmAdoption(input)),
  /** The owner's full record (Owner 2026-10-14): every seat's complete reasoning and the rulings by section; seats only. */
  detail: reader.input(review).query(({ ctx, input }) => ctx.flow.detail(input.reviewId)),
  /** Whether the review is switched on, so the positioning page shows no entry (and no error) when it is off.
   * Membership and balance are still checked by start; a failed settings read reads as off. */
  available: reader.query(async ({ ctx }) => ({ enabled: await readFusionSettings(ctx.admin).then(s => s.review.enabled === true, () => false) })),
  /** Display names of the seats (Owner 2026-10-14): set by administrators, independent of the models; no model names. */
  panel: reader.query(async ({ ctx }) => {
    const names = (await readFusionSettings(ctx.admin)).review.displayNames;
    return { reviewers: PANEL_SEATS.map((seat, i) => ({ seat, name: names.reviewers[i]! })), summary: { seat: 'S', name: names.summary } };
  }),
});
