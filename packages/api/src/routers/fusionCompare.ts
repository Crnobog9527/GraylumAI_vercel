/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { StagingAccessError, stagingProcedureError } from '../services/turn/settings/stagingErrors';
import { compareModelNames, compareOptions } from '../services/fusion/compareOptions';
import { swallow } from '../lib/swallow';
import { adoptTurnCompare, listTurnCompares, readTurnCompare } from '../services/turn/compareCards';

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
  if (/^(FUSION|REPORT)_[A-Z_]+$/.test(message)) {
    return new TRPCError({ code: forbidden.has(message) ? 'FORBIDDEN' : conflict.has(message) ? 'CONFLICT' : 'BAD_REQUEST', message, cause });
  }
  return stagingProcedureError(cause, path);
}

/** Reads (options, turnList, turnRead) and the free adoption: the admin client only. */
const reader = protectedProcedure.use(async ({ ctx, next, path }) => {
  try {
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
    const result = await next({ ctx: { ...ctx, admin: ctx.supabaseAdmin } });
    if (!result.ok) throw result.error;
    return result;
  } catch (cause) { throw compareError(cause, path); }
});
const compare = z.object({ compareId: uuid }).strict();

/** FUSION-COMPARE (§4). Everything is checked on the server again at start: the picker only shows what is allowed.
 * The compare switch is off by default; with it off every work route refuses (FUSION_COMPARE_DISABLED). */
export const fusionCompareRouter = router({
  /** The picker's contents. A failed settings read reads as "off" to the page rather than leaking a database error. */
  options: reader.query(({ ctx }) => compareOptions(ctx.admin, ctx.user.id)),
  /** The compares of a conversation (started on POST /api/turn/compare), listed, read and adopted from turns (CORE-PATH-V2 V2-10).
   * A compare is started and priced only on the turn routes; the old BILL2 routes are gone (V2-12 B4). */
  turnList: reader.input(z.object({ sessionId: uuid }).strict()).query(async ({ ctx, input }) => {
    const cards = await listTurnCompares(ctx.admin, ctx.user.id, input.sessionId);
    // As the old list: a failed name lookup never hides the cards.
    const names = await swallow('fusion_compare_names_failed', compareModelNames(ctx.admin, cards.flatMap(card => card.config?.models ?? [])), {},
      { category: 'api' });
    return { cards, names };
  }),
  turnRead: reader.input(compare).query(({ ctx, input }) => readTurnCompare(ctx.admin, ctx.user.id, input.compareId)),
  turnAdopt: reader.input(compare.extend({ column: z.number().int().min(0).max(7) }).strict())
    .mutation(({ ctx, input }) => adoptTurnCompare(ctx.admin, ctx.user.id, input)),
});
