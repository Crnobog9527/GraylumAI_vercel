/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const meteringReviewInput = z.object({
  callId: z.uuid(),
  requestId: z.uuid(),
  review: z.object({
    expectedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    profileVersion: z.string().trim().min(1).max(128),
    evidenceVersion: z.string().trim().min(1).max(128),
    reviewReference: z.string().trim().min(1).max(500),
    humanReviewed: z.literal(true),
  }).strict(),
}).strict();
const resultSchema = z.object({ callId: z.uuid(), auditId: z.uuid(), reviewed: z.literal(true) }).strict();

function databaseError(error: unknown): never {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : null;
  if (message === 'BILL2_METERING_REVIEW_DENIED') {
    throw new TRPCError({ code: 'FORBIDDEN', message });
  }
  if (message === 'BILL2_METERING_REVIEW_CONFLICT' || message === 'BILL2_METERING_REVIEW_NOT_READY') {
    throw new TRPCError({ code: 'CONFLICT', message });
  }
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'BILL2_METERING_REVIEW_UNAVAILABLE' });
}

/** SQL commits the review and existing audit record atomically; no client-side retry or model toggle. */
export async function reviewMetering(db: SupabaseClient, actorId: string, input: z.infer<typeof meteringReviewInput>) {
  const parsed = meteringReviewInput.parse(input);
  let response;
  try {
    response = await db.rpc('bill2_payg_review_metering', {
      p_actor_id: actorId, p_call_id: parsed.callId, p_request_id: parsed.requestId, p_review: parsed.review,
    });
  } catch (error) { databaseError(error); }
  if (response.error) databaseError(response.error);
  const result = resultSchema.safeParse(response.data);
  if (!result.success || result.data.callId !== parsed.callId) databaseError(null);
  return result.data;
}

export const meteringReviewSnapshotInput = z.object({ callId: z.uuid() }).strict();
const snapshotSchema = z.object({
  callId: z.uuid(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileVersion: z.string().min(1).max(128), evidenceVersion: z.string().min(1).max(128),
  reviewable: z.boolean(), budgetConflict: z.boolean(), meteringMissing: z.boolean(), meteringExit: z.boolean(),
  auditId: z.uuid().nullable(),
}).strict();

export async function meteringReviewSnapshot(db: SupabaseClient, actorId: string, callId: string) {
  let response;
  try {
    response = await db.rpc('bill2_payg_metering_review_snapshot', { p_actor_id: actorId, p_call_id: callId });
  } catch (error) { databaseError(error); }
  if (response.error) databaseError(response.error);
  const result = snapshotSchema.safeParse(response.data);
  if (!result.success || result.data.callId !== callId) databaseError(null);
  return result.data;
}
