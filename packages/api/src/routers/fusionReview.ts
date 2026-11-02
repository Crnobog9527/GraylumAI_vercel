/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router } from '../trpc';
import { StagingAccessError, stagingProcedureError } from '../services/turn/settings/stagingErrors';
import { reportRevisionService } from '../services/report/revisionSync';
import { reviewFlow } from '../services/fusion/review';
import { handReviewToServer } from '../services/fusion/background';
import { ENDED_STATES, reviewState } from '../services/fusion/reviewRecord';
import { adoptionChoices } from '../services/fusion/reviewAdoption';
import { readFusionSettings, PANEL_SEATS } from '../services/fusion/settings';
import { loadVersionMarks } from '../services/fusion/versionMarks';

const uuid = z.string().uuid();
const forbidden = new Set(['FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED', 'FUSION_REVIEW_BREAKER',
  'FUSION_VERSION_MARKS_DENIED']);
const conflict = new Set(['FUSION_REVIEW_ACTIVE', 'FUSION_REVIEW_ENDED', 'FUSION_REVIEW_STEP_CONFLICT', 'FUSION_REVIEW_STALE',
  'FUSION_REVIEW_ADOPTED', 'FUSION_ADOPTION_STALE', 'REPORT_REVISION_STALE', 'REPORT_SOURCE_CONFLICT', 'REPORT_REVISION_DECIDED',
  'FUSION_REVIEW_VERSION_BLOCKED', 'FUSION_REVIEW_CONFLICT', 'FUSION_REVIEW_ESTIMATE_CHANGED']);
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

/** Reads and the chapter choice. A review starts on POST /api/turn (kind=jury), never here (CORE-PATH-V2 V2-12 B5); reading needs
 * no staging window, executor or billing. */
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

const review = z.object({ reviewId: uuid }).strict();
const mineCursor = z.object({ createdAt: z.string().datetime({ offset: true }), reviewId: uuid }).strict();
const mineInput = z.object({ limit: z.number().int().min(1).max(50).default(10), draftId: uuid.optional(),
  cursor: mineCursor.optional() }).strict();
const mineOutput = z.array(z.object({ reviewId: uuid, draftId: uuid, sourceVersionId: uuid, state: reviewState,
  round: z.number().int().min(1), phase: z.enum(['review', 'summary']), outcomeKind: z.string().nullable(),
  awaitingChoice: z.boolean(), createdAt: z.string(), endedAt: z.string().nullable(), seenAt: z.string().nullable() }));
export const fusionReviewRouter = router({
  /** The page only reads now (FUSION-BACKGROUND): returns the review as it stands and hands it to the server again
   * (a no-op while the server holds it). No call is claimed or returned for the page to dispatch. */
  continue: reader.input(review).mutation(async ({ ctx, input }) => {
    const view = await ctx.flow.read(input.reviewId);
    if (!ENDED_STATES.has(view.state)) handReviewToServer(ctx, input.reviewId);
    return { review: view, calls: [] as typeof view.calls, background: true as const };
  }),
  /** The completion notice (FUSION-BACKGROUND): the user's latest reviews, "待选择" / "已暂停" and whether seen. */
  mine: reader.input(mineInput).output(mineOutput).query(async ({ ctx, input }) => {
    const result = await ctx.admin.rpc('fusion_review_mine', { p_actor_id: ctx.user.id, p_limit: input.limit,
      p_draft_id: input.draftId ?? null, p_before_created_at: input.cursor?.createdAt ?? null,
      p_before_id: input.cursor?.reviewId ?? null });
    if (result.error) throw new Error('FUSION_REVIEW_UNAVAILABLE');
    return mineOutput.parse(result.data);
  }),
  /** Report version marks (Owner 2026-10-20): "已评审" / "衍生" per version id for the given analyses, in one call for a whole
   * library. Every analysis must be the caller's own: another user's (or an unknown) one is refused, never answered empty. */
  versionMarks: reader.input(z.object({ draftIds: z.array(uuid).min(1).max(500), versionIds: z.array(uuid).max(2000).optional() }).strict())
    .query(({ ctx, input }) => loadVersionMarks(ctx.admin, ctx.user.id, input.draftIds, input.versionIds)),
  markSeen: reader.input(review).mutation(async ({ ctx, input }) => {
    const result = await ctx.admin.rpc('fusion_review_mark_seen', { p_actor_id: ctx.user.id, p_review_id: input.reviewId });
    if (result.error) throw new Error(result.error.message === 'FUSION_REVIEW_DENIED' ? 'FUSION_REVIEW_DENIED' : 'FUSION_REVIEW_UNAVAILABLE');
    return { seen: true };
  }),
  // No stop or end (Owner 2026-10-17: "评审团功能不提供中途停止的选项，用户只要点了启用，他就必须得用完"): a review only
  // ends on its own; deleting the content or the account still ends it with a full refund (0294).
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
