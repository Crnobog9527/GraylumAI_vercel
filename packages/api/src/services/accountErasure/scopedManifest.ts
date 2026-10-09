/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { isCanonicalErasureAttachment, type ErasureAttachmentManifest } from './storage';

type Read = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<{
  data: unknown; error: unknown;
}>;
const cursorSchema = z.string().regex(/^[01]:[0-9a-f-]{36}:[0-9]{10}$/).nullable();
const progressSchema = z.object({ cursor: cursorSchema, done: z.boolean(), review: z.boolean() }).strict();
const pageSchema = z.object({
  items: z.array(z.object({ path: z.string(), uploaderId: z.union([z.string().uuid(), z.literal('')]), subjectId: z.string().uuid() }).strict()),
  nextCursor: cursorSchema,
}).strict();
const failure = () => new Error('ERASURE_MANIFEST_UNKNOWN');

/** Ticket rows are authoritative. Checkpoint only source row IDs/ordinals after
 * absence proof; no filenames are copied into persistent progress. */
export function createScopedErasureManifest(input: {
  read: Read; verify: (profileId: string, signal: AbortSignal) => Promise<void>;
  requestId: string; token?: string;
}): ErasureAttachmentManifest {
  let current: string | null = null;
  let retainedReview = false;
  let expectedNext: string | null | undefined;
  const binding = (profileId: string) => ({ p_profile_id: profileId, p_request_id: input.requestId, p_token: input.token });
  return {
    async list({ profileId, cursor, limit, signal }) {
      await input.verify(profileId, signal);
      if (signal.aborted || !Number.isInteger(limit) || limit < 1 || limit > 100) throw failure();
      if (cursor === null) {
        const response = await input.read('account_erasure_attachment_checkpoint', binding(profileId), signal);
        if (response.error || signal.aborted) throw failure();
        const progress = progressSchema.parse(response.data);
        if (progress.done) return { items: [], nextCursor: null };
        current = progress.cursor; retainedReview = current !== null && progress.review;
      } else if (cursor !== current) throw failure();
      const result = await input.read('account_erasure_attachment_page', {
        p_profile_id: profileId, p_after: current, p_limit: limit,
      }, signal);
      if (result.error || signal.aborted) throw failure();
      const page = pageSchema.parse(result.data);
      if (page.items.length > limit || page.items.some(row => row.subjectId !== profileId)
        || page.nextCursor !== null && (page.items.length !== limit || current !== null && page.nextCursor <= current)) throw failure();
      expectedNext = page.nextCursor;
      return { ...page, items: page.items.map(row => ({ ...row, uploaderId: row.uploaderId || null })), reviewPending: retainedReview };
    },
    async checkpoint({ profileId, nextCursor, review, signal }) {
      // A completed manifest is read-only on repeat runs.
      if (expectedNext === undefined) return;
      if (nextCursor !== expectedNext || signal.aborted) throw failure();
      await input.verify(profileId, signal);
      const response = await input.read('account_erasure_attachment_checkpoint', {
        ...binding(profileId), p_after: current, p_next: nextCursor, p_commit: true, p_review: review,
      }, signal);
      if (response.error || signal.aborted) throw failure();
      const saved = progressSchema.parse(response.data);
      if (saved.cursor !== nextCursor || saved.done !== (nextCursor === null && !saved.review)) throw failure();
      current = saved.cursor; retainedReview = saved.review; expectedNext = undefined;
    },
    async classify({ profileId, paths, signal }) {
      await input.verify(profileId, signal);
      if (signal.aborted || paths.length > 100 || new Set(paths).size !== paths.length
        || paths.some(path => !isCanonicalErasureAttachment(path))) throw failure();
      const result = await input.read('account_erasure_attachment_classify', { p_profile_id: profileId, p_paths: paths }, signal);
      if (result.error || signal.aborted) throw failure();
      return result.data;
    },
  };
}
