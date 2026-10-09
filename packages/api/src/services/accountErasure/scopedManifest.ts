/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { isCanonicalErasureAttachment, type ErasureAttachmentManifest } from './storage';

type Read = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<{
  data: unknown; error: unknown;
}>;
const pageSchema = z.object({
  items: z.array(z.object({ path: z.string(), uploaderId: z.string().uuid(), subjectId: z.string().uuid() }).strict()),
  nextCursor: z.string().nullable(),
}).strict();
const failure = () => new Error('ERASURE_MANIFEST_UNKNOWN');

/** Existing ticket/reply rows remain authoritative. SQL fetches only this subject's
 * raw paths and checks candidate references across all subjects using GIN indexes. */
export function createScopedErasureManifest(input: {
  read: Read; verify: (profileId: string, signal: AbortSignal) => Promise<void>;
}): ErasureAttachmentManifest {
  return {
    async list({ profileId, cursor, limit, signal }) {
      await input.verify(profileId, signal);
      if (signal.aborted || !Number.isInteger(limit) || limit < 1 || limit > 100
        || cursor !== null && !isCanonicalErasureAttachment(cursor)) throw failure();
      const result = await input.read('account_erasure_attachment_page', {
        p_profile_id: profileId, p_after: cursor, p_limit: limit,
      }, signal);
      if (result.error || signal.aborted) throw failure();
      const page = pageSchema.parse(result.data);
      if (page.items.length > limit || page.items.some((row, index) =>
        row.subjectId !== profileId || !isCanonicalErasureAttachment(row.path)
        || !row.path.startsWith(`${row.uploaderId}/`) || cursor !== null && row.path <= cursor
        || index > 0 && row.path <= page.items[index - 1].path)
        || page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.path) throw failure();
      return page;
    },
    async classify({ profileId, paths, signal }) {
      await input.verify(profileId, signal);
      if (signal.aborted || paths.length > 100 || new Set(paths).size !== paths.length
        || paths.some(path => !isCanonicalErasureAttachment(path))) throw failure();
      const result = await input.read('account_erasure_attachment_classify', {
        p_profile_id: profileId, p_paths: paths,
      }, signal);
      if (result.error || signal.aborted) throw failure();
      // The Storage core validates exact path coverage and the closed enum before deletion.
      return result.data;
    },
  };
}
