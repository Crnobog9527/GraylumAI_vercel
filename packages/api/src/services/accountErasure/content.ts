/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

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
  return parsed.data;
}
export const conversationTarget = z.object({ sessionId: z.string().uuid() }).strict();
/**
 * Owner 2026-10-13: deleting a whole conversation shows no impact list and completes at once.
 * One small step (0231 content_erasure_mark_session): only this session is locked and its
 * irreversible marker committed, after which every read, write, replay and late result is refused.
 * The kind is fixed to `session` and the database still checks ownership.
 */
export async function eraseConversation(database: Database | null | undefined, actorId: string,
  input: z.infer<typeof conversationTarget>) {
  if (!database) fail(null);
  const { sessionId } = conversationTarget.parse(input);
  const response = await database.rpc('content_erasure_mark_session', { a: actorId, target: sessionId });
  if (response.error) fail(response.error);
  const parsed = confirmationResult.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== sessionId || parsed.data.kind !== 'session') fail(null);
  return parsed.data;
}
/**
 * Physical cleanup of a marked conversation: the unchanged content_erasure_confirm on its
 * already-deleted path (no preview hash; an unmarked session is refused). Busy is not an error
 * here: the account-erasure cron sweeps whatever is left.
 */
export async function cleanUpConversation(database: Database | null | undefined, actorId: string,
  input: z.infer<typeof conversationTarget>) {
  if (!database) fail(null);
  const { sessionId } = conversationTarget.parse(input);
  const response = await database.rpc('content_erasure_confirm', { a: actorId, k: 'session', target: sessionId, expected_hash: null });
  if (response.error?.message === 'CONTENT_ERASURE_BUSY') return { cleaned: false };
  if (response.error) fail(response.error);
  const parsed = confirmationResult.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== sessionId || parsed.data.kind !== 'session') fail(null);
  return { cleaned: true };
}
const sweepPage = z.object({
  cleaned: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  more: z.boolean(), afterAt: z.string().nullable(), afterId: z.string().uuid().nullable(),
}).strict();
export type ConversationSweep = { cleaned: number; pending: number; failed: number; more: boolean };
/**
 * Cron backstop (0231): pages through every marked conversation the client did not finish, until the
 * backlog is drained or the time budget ends (`more` then stays true and the run reports it).
 * Busy conversations stay pending for the next run; any other failure is counted as failed.
 */
export async function sweepErasedConversations(database: Database, budgetMs = 25_000, now = () => Date.now()) {
  const deadline = now() + budgetMs;
  const total: ConversationSweep = { cleaned: 0, pending: 0, failed: 0, more: false };
  let cursor: { afterAt: string | null; afterId: string | null } = { afterAt: null, afterId: null };
  do {
    const response = await database.rpc('content_erasure_sweep_sessions', {
      lim: 50, after_at: cursor.afterAt, after_id: cursor.afterId,
    });
    if (response.error) throw new Error('CONTENT_ERASURE_SWEEP_FAILED');
    const page = sweepPage.parse(response.data);
    total.cleaned += page.cleaned; total.pending += page.pending; total.failed += page.failed;
    total.more = page.more;
    cursor = page;
  } while (total.more && now() < deadline);
  return total;
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
