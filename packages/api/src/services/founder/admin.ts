/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callFounderRpc } from './member';
import { founderStatusSchema, founderWallEntrySchema, founderWallLink } from './schemas';

/**
 * PAY-FOUNDER PR-F1, admin side: wall review, the founder list with community bookkeeping, the community
 * entry and livestream records. Every RPC re-checks the admin role in the database (founder_admin_check).
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const timestamp = z.string().min(1);
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !CONTROL.test(value), 'FOUNDER_TEXT_INVALID');
const optionalLink = z.union([z.string().max(2048), z.null()]).transform((value, ctx) => {
  if (value === null || value.trim() === '') return null;
  const href = founderWallLink(value);
  if (!href) ctx.addIssue({ code: 'custom', message: 'FOUNDER_LINK_INVALID' });
  return href;
});

export const founderWallReviewInput = z.object({
  userId: uuid,
  decision: z.enum(['approved', 'rejected']),
  /** updatedAt of the card as the admin saw it, verbatim; a card edited since then is a conflict. */
  seenUpdatedAt: timestamp.max(64),
}).strict();
export const founderCommunityMarkInput = z.object({ userId: uuid, action: z.enum(['joined', 'removed']) }).strict();
export const founderCommunityEntryInput = z.object({
  url: optionalLink, note: z.union([text(500), z.literal('').transform(() => null), z.null()]),
}).strict();
export const founderLivestreamInput = z.object({
  requestId: uuid,
  heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  topic: text(120),
  replayUrl: optionalLink,
}).strict();

const overviewSchema = z.array(z.object({
  userId: uuid,
  email: z.string().nullable(),
  founder: founderStatusSchema,
  foundedAt: timestamp.nullable(),
  accountOpen: z.boolean(),
  community: z.object({ joinedAt: timestamp.nullable(), removedAt: timestamp.nullable() }).strict(),
  pendingRemoval: z.boolean(),
  wall: founderWallEntrySchema.extend({ consented: z.boolean(), listed: z.boolean() }).strict().nullable(),
}).strict());
const reviewSchema = founderWallEntrySchema.extend({ listed: z.boolean() }).strict();
const communitySchema = z.object({ userId: uuid, joinedAt: timestamp.nullable(), removedAt: timestamp.nullable() }).strict();
const entrySchema = z.object({
  url: z.string().nullable(), note: z.string().nullable(), updatedBy: uuid, updatedAt: timestamp,
}).strict().nullable();
const livestreamsSchema = z.array(z.object({
  id: uuid, heldOn: z.string(), topic: z.string(), replayUrl: z.string().nullable(),
  recordedBy: uuid.nullable(), recordedAt: timestamp,
}).strict());

export function founderAdminOverview(db: Rpc, actorId: string) {
  return callFounderRpc(db, 'founder_admin_overview', { p_actor: uuid.parse(actorId) }, overviewSchema);
}

export function reviewFounderWall(db: Rpc, actorId: string, input: z.input<typeof founderWallReviewInput>) {
  const { userId, decision, seenUpdatedAt } = founderWallReviewInput.parse(input);
  return callFounderRpc(db, 'founder_wall_review', {
    p_actor: uuid.parse(actorId), p_user: userId, p_decision: decision, p_seen_updated_at: seenUpdatedAt,
  }, reviewSchema);
}

export function markFounderCommunity(db: Rpc, actorId: string, input: z.input<typeof founderCommunityMarkInput>) {
  const { userId, action } = founderCommunityMarkInput.parse(input);
  return callFounderRpc(db, 'founder_community_mark', { p_actor: uuid.parse(actorId), p_user: userId, p_action: action },
    communitySchema);
}

export function setFounderCommunityEntry(db: Rpc, actorId: string, input: z.input<typeof founderCommunityEntryInput>) {
  const { url, note } = founderCommunityEntryInput.parse(input);
  return callFounderRpc(db, 'founder_community_entry_set', { p_actor: uuid.parse(actorId), p_url: url, p_note: note },
    entrySchema);
}

export function listFounderLivestreams(db: Rpc, actorId: string) {
  return callFounderRpc(db, 'founder_livestream_list', { p_actor: uuid.parse(actorId) }, livestreamsSchema);
}

export function recordFounderLivestream(db: Rpc, actorId: string, input: z.input<typeof founderLivestreamInput>) {
  const { requestId, heldOn, topic, replayUrl } = founderLivestreamInput.parse(input);
  return callFounderRpc(db, 'founder_livestream_record', {
    p_actor: uuid.parse(actorId), p_request: requestId, p_held_on: heldOn, p_topic: topic, p_replay_url: replayUrl,
  }, livestreamsSchema);
}
