/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
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

const uuid = z.string().uuid();
const forbidden = new Set(['FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED', 'FUSION_REVIEW_BREAKER']);
const conflict = new Set(['FUSION_REVIEW_ACTIVE', 'FUSION_REVIEW_ENDED', 'FUSION_REVIEW_STEP_CONFLICT', 'FUSION_REVIEW_STALE',
  'FUSION_REVIEW_VERSION_BLOCKED', 'FUSION_REVIEW_CONFLICT']);
/** Exact Fusion refusals keep their code for the page; anything else goes through the staging error mapping. */
function reviewError(cause: unknown, path: string): TRPCError {
  const message = cause instanceof Error ? cause.message : '';
  if (/^(FUSION|REPORT)_[A-Z_]+$/.test(message)) {
    return new TRPCError({ code: forbidden.has(message) ? 'FORBIDDEN' : conflict.has(message) ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
  return stagingProcedureError(cause, path);
}

/** FUSION-REVIEW review API (staging test window only, like Runtime real calls). One request per model call. */
const procedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const admin = ctx.supabaseAdmin;
    const window = await loadStagingPolicy(admin as unknown as BillingRpc, ctx.user.id, process.env);
    const budget = ctx.runtimeBudget ?? createRuntimeBudget();
    const actor = runtimeActor(ctx.userScopedSupabase.auth, ctx.user.id, budget, ctx.headers?.get('Authorization'));
    const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor, adapter: stagingTransport(admin, window, budget), budget });
    const executor = fusionExecutor({ billing, admin, actorId: ctx.user.id, callGate: newWorkGate(admin, 'staging').calls, budget });
    const revisions = reportRevisionService(ctx.userScopedSupabase, admin);
    const flow = reviewFlow({ admin, actorId: ctx.user.id, executor,
      propose: async input => ({ revisionId: (await revisions.propose(input)).revisionId }) });
    const result = await next({ ctx: { ...ctx, flow } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw reviewError(cause instanceof TRPCError && cause.cause ? cause.cause : cause, path); }
});
const review = z.object({ reviewId: uuid }).strict();

export const fusionReviewRouter = router({
  start: procedure.input(z.object({ requestId: uuid, draftId: uuid, sourceVersionId: uuid }).strict())
    .mutation(({ ctx, input }) => ctx.flow.start(input)),
  /** Repeatable: decides and claims the next step, or returns the calls still to dispatch. */
  continue: procedure.input(review).mutation(({ ctx, input }) => ctx.flow.continue(input.reviewId)),
  dispatch: procedure.input(review.extend({ callId: uuid })).mutation(({ ctx, input }) => ctx.flow.dispatch(input.reviewId, input.callId)),
  stop: procedure.input(review).mutation(({ ctx, input }) => ctx.flow.stop(input.reviewId)),
  end: procedure.input(review).mutation(({ ctx, input }) => ctx.flow.end(input.reviewId)),
});
