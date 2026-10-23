/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { StagingAccessError, stagingProcedureError } from '../services/runtime/stagingErrors';
import { compareOptions } from '../services/fusion/compareOptions';
import { compareRpc } from '../services/fusion/compareAdmission';
import { compareSkillInput } from '../services/fusion/compareLoad';
import { liveCompare, type CompareCtx } from '../services/fusion/compareLive';
import type { ColumnEvent } from '../services/fusion/compareColumn';

const uuid = z.string().uuid();
const forbidden = new Set(['FUSION_COMPARE_DISABLED', 'FUSION_COMPARE_FORBIDDEN', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED',
  'FUSION_COMPARE_BREAKER']);
const conflict = new Set(['FUSION_COMPARE_ACTIVE', 'FUSION_COMPARE_ENDED', 'FUSION_COMPARE_STALE', 'FUSION_COMPARE_ADOPTED',
  'FUSION_COMPARE_REQUEST_CONFLICT', 'FUSION_COMPARE_PRICE_CHANGED', 'FUSION_COMPARE_SESSION_BUSY', 'FUSION_GROUP_CONFLICT']);
/** Exact compare refusals keep their code for the page (it maps them to plain words); anything else goes through the staging
 * mapping, which never shows database detail. */
function compareError(thrown: unknown, path: string): TRPCError {
  // An error thrown inside a procedure reaches the middleware wrapped as an internal error; input and auth errors do not.
  const cause = thrown instanceof TRPCError && thrown.code === 'INTERNAL_SERVER_ERROR' && thrown.cause ? thrown.cause : thrown;
  if (cause instanceof TRPCError) return cause;
  const message = cause instanceof Error ? cause.message : '';
  if (/^FUSION_[A-Z_]+$/.test(message)) {
    return new TRPCError({ code: forbidden.has(message) ? 'FORBIDDEN' : conflict.has(message) ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
  return stagingProcedureError(cause, path);
}

/** Reads (options, list, read): the admin client only. */
const reader = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const result = await next({ ctx: { ...ctx, admin: ctx.supabaseAdmin } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw compareError(cause, path); }
});
/** Work (estimate, start, stream, stop, adopt): the staging test window, billing and executor, as for a review call. */
const worker = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    const result = await next({ ctx: { ...ctx, compare: await liveCompare(ctx as CompareCtx) } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw compareError(cause, path); }
});

const request = z.object({ sessionId: uuid, question: z.string().trim().min(1).max(20000), modelIds: z.array(uuid).min(1).max(8),
  skill: compareSkillInput.optional() }).strict();
const quote = z.object({ credits: z.number().int().nonnegative(), columns: z.array(z.object({ modelId: uuid,
  credits: z.number().int().nonnegative(), usd: z.string().regex(/^\d+(\.\d+)?$/) }).strict()).min(1).max(8) }).strict();
const compare = z.object({ compareId: uuid }).strict();

/** FUSION-COMPARE (§4). Everything is checked on the server again at start: the picker only shows what is allowed.
 * The compare switch is off by default; with it off every work route refuses (FUSION_COMPARE_DISABLED). */
export const fusionCompareRouter = router({
  /** The picker's contents. A failed settings read reads as "off" to the page rather than leaking a database error. */
  options: reader.query(({ ctx }) => compareOptions(ctx.admin, ctx.user.id)),
  /** This conversation's compare cards, oldest first, with the server-written adoption (the adopted answer's execution). */
  list: reader.input(z.object({ sessionId: uuid }).strict())
    .query(({ ctx, input }) => compareRpc<unknown[]>(ctx.admin, 'fusion_compare_list', { p_actor_id: ctx.user.id, p_session_id: input.sessionId })),
  /** "At most X credits": priced per chosen model, nothing recorded, no paid judgement; repeatable. */
  estimate: worker.input(request).mutation(({ ctx, input }) => ctx.compare.estimate(input)),
  /** Records, judges positioning once, admits and claims the whole group (or answers waiting_credits, holding nothing). */
  start: worker.input(request.extend({ requestId: uuid, shown: quote }).strict()).mutation(({ ctx, input }) => ctx.compare.start(input)),
  /** One column, one streamed request: dispatches at most once; a repeat answers `already` and the page reads instead. */
  stream: worker.input(compare.extend({ column: z.number().int().min(0).max(7) }).strict())
    .mutation(async function* ({ ctx, input }): AsyncGenerator<ColumnEvent> { yield* ctx.compare.stream(input); }),
  /** Every column's state, body, charged credits and the total; finishes a compare whose runs are all closed. */
  read: worker.input(compare).query(({ ctx, input }) => ctx.compare.read(input.compareId)),
  /** Stop the whole compare, or one column (after the claim). Undispatched calls are released free. */
  stop: worker.input(compare.extend({ column: z.number().int().min(0).max(7).optional() }).strict())
    .mutation(({ ctx, input }) => ctx.compare.stop(input)),
  /** "Use this answer": writes the pair into the main conversation, or returns a quote when it moved on. Free. */
  adopt: worker.input(compare.extend({ column: z.number().int().min(0).max(7), requestId: uuid }).strict())
    .mutation(({ ctx, input }) => ctx.compare.adopt(input)),
});
