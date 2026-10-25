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
  // The mark recorded the deletion in the database outbox (0227); push it off-database now,
  // best effort, like every other confirmed deletion (backup-restore replay runbook).
  scheduleErasureManifestSync(database);
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
  if (response.error?.message === 'CONTENT_ERASURE_BUSY') return { cleaned: false, reviewRequired: false };
  if (response.error) fail(response.error);
  const parsed = confirmationResult.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== sessionId || parsed.data.kind !== 'session') fail(null);
  // Unresolved money on the deleted conversation is reported here, as the confirm call used to.
  return { cleaned: true, reviewRequired: parsed.data.status === 'review_required' };
}
const sweepPage = z.object({
  cleaned: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  more: z.boolean(), afterAt: z.string().nullable(), afterId: z.string().uuid().nullable(),
}).strict();
export type ConversationSweep = { cleaned: number; pending: number; failed: number; more: boolean };
type SweepDatabase = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> & { abortSignal?: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: { message?: string } | null }> } };
/**
 * Cron backstop (0231): pages through every marked conversation the client did not finish. A pass
 * that ends with busy (pending) or failed rows starts again from the oldest, up to three passes,
 * while the route's shared deadline allows. The result describes the last pass: anything still
 * pending, failed or unreached (`more`) fails the run, so the 24-hour cleanup bound is never missed
 * silently. Each page call is bounded by the time left.
 */
export async function sweepErasedConversations(database: SweepDatabase, deadline: number, now = () => Date.now()) {
  let cleaned = 0;
  let last: ConversationSweep = { cleaned: 0, pending: 0, failed: 0, more: true };
  for (let pass = 0; pass < 3 && deadline - now() > 3_000; pass += 1) {
    const current: ConversationSweep = { cleaned: 0, pending: 0, failed: 0, more: true };
    let cursor: { afterAt: string | null; afterId: string | null } = { afterAt: null, afterId: null };
    while (current.more && deadline - now() > 3_000) {
      // One conversation per call: each RPC is its own transaction, so every finished cleanup is
      // committed and an abort at the deadline loses at most the one in progress.
      const call = database.rpc('content_erasure_sweep_sessions', {
        lim: 1, after_at: cursor.afterAt, after_id: cursor.afterId,
      });
      const response = await (call.abortSignal ? call.abortSignal(AbortSignal.timeout(deadline - now())) : call);
      if (response.error) throw new Error('CONTENT_ERASURE_SWEEP_FAILED');
      const page = sweepPage.parse(response.data);
      current.cleaned += page.cleaned; current.pending += page.pending; current.failed += page.failed;
      current.more = page.more;
      cursor = page;
    }
    cleaned += current.cleaned;
    last = current;
    if (current.more || (!current.pending && !current.failed)) break;
  }
  return { ...last, cleaned };
}
/** Recheck before returning buffered text/results. No positive cache survives a
 * deletion. The existing invocation still completes its original money recovery.
 * DB-PERF PR-2A: the same round trip also checks the voice version and library references the
 * execution froze, when asked; it returns which of them is gone, and null when all are shown. */
export function contentVisibilityFence(database: Database, actorId: string, executionId: string) {
  return async (sources: { voice?: boolean; library?: boolean } = {}): Promise<'voice' | 'library' | null> => {
    const response = await database.rpc('runtime_execution_visibility', { p_actor_id: actorId,
      p_execution_id: executionId, p_voice: sources.voice === true, p_library: sources.library === true });
    if (response.error) fail(response.error);
    if (response.data === 'voice' || response.data === 'library') return response.data;
    if (response.data !== 'visible') fail(null);
    return null;
  };
}

/** Recognize only the exact database tombstone refusal; other errors stay private. */
export function throwIfContentErased(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error
    && error.code === '42501' && error.message === 'CONTENT_ERASED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'CONTENT_ERASED' });
  }
}
