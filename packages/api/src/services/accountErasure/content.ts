/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { scheduleErasureManifestSync } from './offdbManifest';

export const contentTarget = z.object({
  kind: z.enum(['answer', 'session', 'artifact', 'content']),
  id: z.string().uuid(),
}).strict();
/**
 * Owner 2026-10-13: like ChatGPT and Claude, a user deletes a whole conversation, never one answer.
 * The `answer` scope stays in the database functions for internal use; the user-facing API refuses it.
 */
export function assertUserErasable(kind: z.infer<typeof contentTarget>['kind']) {
  if (kind === 'answer') throw new TRPCError({ code: 'FORBIDDEN', message: 'CONTENT_ERASURE_SCOPE_DISABLED' });
}
export const contentConfirmation = contentTarget.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledged: z.literal(true),
}).strict();
type Database = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> };
const previewResult = contentTarget.extend({
  affectedSources: z.array(z.object({ kind: z.enum(['account', 'work_item', 'reference', 'content']), id: z.string().uuid() }).strict()),
  alreadyDeleted: z.boolean(), affectedExecutions: z.number().int().nonnegative(),
  preservedSavedVersions: z.number().int().nonnegative(), previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const confirmationResult = contentTarget.extend({
  status: z.enum(['deleted', 'review_required']), alreadyDeleted: z.boolean(),
  preservedSavedVersions: z.number().int().nonnegative(), financialReviewCount: z.number().int().nonnegative(),
}).strict();
const failures = {
  CONTENT_NOT_FOUND: 'NOT_FOUND',
  CONTENT_ERASED: 'PRECONDITION_FAILED',
  CONTENT_ERASURE_PREVIEW_CHANGED: 'CONFLICT',
  CONTENT_ERASURE_BUSY: 'CONFLICT',
} as const;
function fail(error: { code?: string; message?: string } | null): never {
  const name = error?.message as keyof typeof failures;
  if (name && name in failures) throw new TRPCError({ code: failures[name], message: name });
  // Neither database text nor an error cause carrying private content is exposed.
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'CONTENT_ERASURE_UNAVAILABLE' });
}
export async function previewContentErasure(database: Database | null | undefined, actorId: string,
  input: z.infer<typeof contentTarget>) {
  if (!database) fail(null);
  const target = contentTarget.parse(input);
  const response = await database.rpc('content_erasure_preview', { a: actorId, k: target.kind, target: target.id });
  if (response.error) fail(response.error);
  const parsed = previewResult.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== target.id || parsed.data.kind !== target.kind) fail(null);
  return parsed.data;
}
export async function confirmContentErasure(database: Database | null | undefined, actorId: string,
  input: z.infer<typeof contentConfirmation>) {
  if (!database) fail(null);
  const target = contentConfirmation.parse(input);
  const response = await database.rpc('content_erasure_confirm', {
    a: actorId, k: target.kind, target: target.id, expected_hash: target.previewHash,
  });
  if (response.error) fail(response.error);
  const parsed = confirmationResult.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== target.id || parsed.data.kind !== target.kind) fail(null);
  scheduleErasureManifestSync(database);
  return parsed.data;
}
export const conversationTarget = z.object({ sessionId: z.string().uuid() }).strict();
/**
 * Owner 2026-10-13: deleting a whole conversation shows no impact list, only "cannot be undone".
 * The server computes the scope itself: the kind is fixed to `session`, the database scope function
 * still checks ownership, and the hash it just produced is confirmed under the same row locks, so
 * the irreversible marker, late-result refusal and replay refusal of content_erasure_confirm are
 * unchanged. A scope that grows between the two calls (a reply landing) is recomputed, not trusted.
 */
export async function eraseConversation(database: Database | null | undefined, actorId: string,
  input: z.infer<typeof conversationTarget>) {
  const { sessionId } = conversationTarget.parse(input);
  const target = { kind: 'session' as const, id: sessionId };
  for (let attempt = 1; ; attempt += 1) {
    const preview = await previewContentErasure(database, actorId, target);
    try {
      return await confirmContentErasure(database, actorId, { ...target, previewHash: preview.previewHash, acknowledged: true });
    } catch (error) {
      const changed = error instanceof TRPCError && error.message === 'CONTENT_ERASURE_PREVIEW_CHANGED';
      if (!changed || attempt >= 3) throw error;
    }
  }
}
/** Recheck before returning buffered text/results. No positive cache survives a
 * deletion. The existing invocation still completes its original money recovery. */
export function contentVisibilityFence(database: Database, actorId: string, executionId: string) {
  return async () => {
    const response = await database.rpc('content_erasure_visible', { a: actorId, eid: executionId });
    if (response.error) fail(response.error);
    if (response.data !== true) fail(null);
  };
}

/** Recognize only the exact database tombstone refusal; other errors stay private. */
export function throwIfContentErased(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error
    && error.code === '42501' && error.message === 'CONTENT_ERASED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'CONTENT_ERASED' });
  }
}
