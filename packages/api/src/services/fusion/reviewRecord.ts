/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FrozenCall } from '../bill2/service';

/** The review record (0236). Progress lives on the server; every write takes the review row lock first. */
const uuid = z.string().uuid();
export const reviewState = z.enum(['running', 'paused', 'stopped', 'interrupted', 'revision_failed', 'incomplete', 'completed']);
export type ReviewState = z.infer<typeof reviewState>;
export const ENDED_STATES: ReadonlySet<ReviewState> = new Set(['stopped', 'interrupted', 'revision_failed', 'incomplete', 'completed']);
export type ReviewPosition = { round: number; phase: 'review' | 'summary'; attempt: number };
export const reviewFee = z.object({ credits: z.number().int().positive(), state: z.enum(['held', 'charged', 'refunded']),
  chargedCredits: z.number().int().nonnegative().nullable(), reason: z.string().nullable(), settledAt: z.string().nullable() });
export type ReviewFee = z.infer<typeof reviewFee>;
const reviewView = z.object({
  reviewId: uuid, state: reviewState, round: z.number().int().min(1), phase: z.enum(['review', 'summary']),
  attempt: z.number().int().min(1), draftId: uuid, sourceVersionId: uuid, sourceSessionId: uuid,
  versionHash: z.string(), materials: z.record(z.string(), z.record(z.string(), z.object({ value: z.unknown(), status: z.unknown() }))),
  materialsHash: z.string().regex(/^[a-f0-9]{64}$/), config: z.record(z.string(), z.unknown()),
  steps: z.array(z.object({ round: z.number(), phase: z.string(), attempt: z.number(), groupId: uuid, stepKey: z.string(),
    claimedAt: z.string() })),
  outcome: z.unknown().nullable(), revisionId: uuid.nullable(), endedAt: z.string().nullable(),
  /** The user's per-section choice (0256), once made. */
  adoption: z.record(z.string(), z.unknown()).nullable().optional(),
  /** The fixed price of the review (0294); null for reviews started before it (per-call billing). */
  fee: reviewFee.nullable().optional(),
  /** CORE-PATH-V2 V2-7b: the jury turn of a review on the turn path (null on the BILL2 path). */
  turnId: z.number().int().positive().nullable().optional(),
  calls: z.array(z.object({ groupId: uuid, runId: uuid, callId: uuid, modelId: uuid, phase: z.string(), dispatched: z.boolean(),
    verdict: z.string().nullable(), settled: z.boolean(), state: z.string(),
    dispatchedAt: z.string().nullable().optional(), settledAt: z.string().nullable().optional(),
    /** The turn call sequence (turn path only). */
    seq: z.number().int().positive().optional() })),
});
export type ReviewView = z.infer<typeof reviewView>;
const refusals = new Set(['OPC_BUSINESS_ARCHIVED', 'FUSION_REVIEW_DISABLED', 'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED',
  'REPORT_ENTITLEMENTS_UNAVAILABLE', 'FUSION_REVIEW_STALE', 'FUSION_REVIEW_ACTIVE', 'FUSION_REVIEW_BREAKER',
  'FUSION_REVIEW_VERSION_BLOCKED', 'FUSION_BUDGET_EXCEEDED', 'FUSION_REVIEW_CONFLICT', 'FUSION_REVIEW_INVALID',
  'FUSION_REVIEW_DENIED', 'FUSION_REVIEW_ENDED', 'FUSION_REVIEW_STEP_CONFLICT', 'FUSION_GROUP_DENIED', 'FUSION_GROUP_CONFLICT',
  'FUSION_GROUP_INVALID', 'BILL2_CALL_CONFLICT', 'BILL2_RUN_DENIED',
  // The losing side of a concurrent adoption: the conflict, never a generic failure (#962 review).
  'FUSION_REVIEW_ADOPTED',
  // 0294: the balance does not cover the fixed price (plus a step's temporary hold), or the price changed meanwhile.
  'FUSION_REVIEW_CREDITS', 'FUSION_REVIEW_PRICE_CHANGED']);

export function reviewRecord(admin: SupabaseClient, actorId: string) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await admin.rpc(name, { p_actor_id: uuid.parse(actorId), ...args });
    if (result.error) {
      const message = typeof result.error.message === 'string' ? result.error.message : '';
      throw new Error(refusals.has(message) ? message : 'FUSION_REVIEW_UNAVAILABLE');
    }
    return result.data;
  }
  const view = async (value: Promise<unknown>) => reviewView.parse(await value);
  return {
    /** Starts (or replays) a review of the current formal version; materials are frozen in the database. */
    start: (input: { requestId: string; draftId: string; sourceVersionId: string; config: Record<string, unknown> & { estimateUsd: string } }) =>
      view(rpc('fusion_review_start', { p_request_id: uuid.parse(input.requestId), p_draft_id: uuid.parse(input.draftId),
        p_source_version_id: uuid.parse(input.sourceVersionId), p_config: input.config })),
    /** The review an earlier start with this request created, or null. The database answers a known request
     * before it reads anything else, and refuses an empty config before any write, so this never creates one. */
    async replay(input: { requestId: string; draftId: string; sourceVersionId: string }): Promise<ReviewView | null> {
      try {
        return await view(rpc('fusion_review_start', { p_request_id: uuid.parse(input.requestId), p_draft_id: uuid.parse(input.draftId),
          p_source_version_id: uuid.parse(input.sourceVersionId), p_config: {} }));
      } catch (error) {
        if (error instanceof Error && error.message === 'FUSION_REVIEW_INVALID') return null;
        throw error;
      }
    },
    /** Writes the per-section choice once; the same request returns the same record. */
    recordAdoption: (reviewId: string, adoption: Record<string, unknown>) =>
      view(rpc('fusion_review_adoption_record', { p_review_id: uuid.parse(reviewId), p_adoption: adoption })),
    async read(reviewId: string): Promise<ReviewView | null> {
      const value = await rpc('fusion_review_read', { p_review_id: uuid.parse(reviewId) });
      return value === null ? null : reviewView.parse(value);
    },
    /** Group claim for the current step inside the review lock (refused once the review ended). */
    async claim(reviewId: string, at: ReviewPosition, groupId: string, items: Array<{ runId: string; payload: FrozenCall }>) {
      return await rpc('fusion_review_claim', { p_review_id: uuid.parse(reviewId), p_round: at.round, p_phase: at.phase,
        p_attempt: at.attempt, p_group_id: uuid.parse(groupId),
        p_items: items.map(item => ({ runId: item.runId, sequence: 1, payload: item.payload })) }) as {
        state: 'claimed' | 'waiting_credits'; calls: Array<{ runId: string; id: string; state: string; dispatchToken: string | null }> };
    },
    advance: (reviewId: string, from: ReviewPosition, to: ({ state: 'running' } & ReviewPosition)
      | { state: 'revision_failed' | 'incomplete' | 'completed'; outcome: unknown; revisionId?: string }) =>
      view(rpc('fusion_review_advance', { p_review_id: uuid.parse(reviewId), p_from: from, p_to: to })),
    /** Settles the held fee of an ended review once its calls have settled (idempotent; 0294). */
    async settleFee(reviewId: string): Promise<ReviewFee | null> {
      const value = await rpc('fusion_review_fee_settle', { p_review_id: uuid.parse(reviewId) });
      return value === null ? null : reviewFee.parse(value);
    },
    /** stopped: user stop of a running or paused review; interrupted: user ends a paused review. */
    close: (reviewId: string, state: 'stopped' | 'interrupted') =>
      view(rpc('fusion_review_close', { p_review_id: uuid.parse(reviewId), p_state: state })),
  };
}
