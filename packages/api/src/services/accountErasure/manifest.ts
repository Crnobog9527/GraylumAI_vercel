/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCanonicalErasureAttachment, type ErasureAttachmentManifest } from './storage';

const uuid = z.string().uuid();
const attachments = z.array(z.string()).nullable();
const ticketSchema = z.object({ id: uuid, user_id: uuid.nullable(), attachments }).strict();
const replySchema = z.object({ id: uuid, ticket_id: uuid, user_id: uuid.nullable(), attachments }).strict();
const limitsSchema = z.object({
  pageSize: z.number().int().min(1).max(1000), maxRows: z.number().int().min(1).max(10000),
  timeoutMs: z.number().int().min(1).max(5000),
}).strict();
const failure = () => new Error('ERASURE_MANIFEST_UNKNOWN');
type Reference = { path: string; uploaderId: string; subjectId: string };

/** Reads current raw references, including soft-deleted tickets and administrator replies.
 * This cannot recover previously purged references or prove historical completeness.
 * A trusted host must supply that independent proof; absence of a verifier fails closed.
 * No credentials or persistent snapshot; executor.ts supplies the DB-backed proof.
 * Reference/upload quiescence must still cover classification through external deletion. */
export function createErasureAttachmentManifest(input: {
  client: Pick<SupabaseClient, 'from'>;
  verifyRetainedHistory?: (profileId: string, signal: AbortSignal) => Promise<void>;
  limits?: { pageSize?: number; maxRows?: number; timeoutMs?: number };
}): ErasureAttachmentManifest {
  const limits = limitsSchema.parse({ pageSize: 100, maxRows: 5000, timeoutMs: 2000, ...input.limits });
  const inventory = async (profileId: string, signal: AbortSignal): Promise<Reference[]> => {
    uuid.parse(profileId);
    if (signal.aborted || !input.verifyRetainedHistory) throw failure();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, limits.timeoutMs);
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
    });
    const collect = async <T extends { id: string }>(table: string, columns: string, schema: z.ZodType<T>) => {
      const rows: T[] = [];
      let after: string | null = null;
      let expected: number | undefined;
      while (true) {
        if (controller.signal.aborted) throw failure();
        let query = input.client.from(table).select(columns, { count: 'exact' }).order('id').limit(limits.pageSize);
        if (after) query = query.gt('id', after);
        const result = await query.abortSignal(controller.signal);
        if (result.error || !Number.isInteger(result.count) || result.count! < 0) throw failure();
        const count = result.count!;
        if (expected !== undefined && count !== expected - rows.length) throw failure();
        expected ??= count;
        if (expected > limits.maxRows) throw failure();
        const page = z.array(schema).parse(result.data);
        if (page.length !== Math.min(count, limits.pageSize)) throw failure();
        for (const row of page) {
          if (after !== null && row.id <= after) throw failure();
          after = row.id;
          rows.push(row);
        }
        if (count <= limits.pageSize) return rows;
      }
    };
    try {
      const work = async () => {
        await input.verifyRetainedHistory!(profileId, controller.signal);
        if (controller.signal.aborted) throw failure();
        const tickets = await collect('tickets', 'id,user_id,attachments', ticketSchema);
        const replies = await collect('ticket_replies', 'id,ticket_id,user_id,attachments', replySchema);
        const owners = new Map(tickets.map(row => [row.id, row.user_id]));
        const refs: Reference[] = [];
        const add = (paths: string[] | null, subjectId: string, uploaderIds: string[]) => {
          for (const path of paths ?? []) {
            const uploaderId = path.split('/')[0];
            if (!isCanonicalErasureAttachment(path) || !uploaderIds.includes(uploaderId)) throw failure();
            refs.push({ path, uploaderId, subjectId });
          }
        };
        for (const row of tickets) {
          if (!row.attachments?.length) continue;
          if (!row.user_id) throw failure();
          add(row.attachments, row.user_id, [row.user_id]);
        }
        for (const row of replies) {
          if (!row.attachments?.length) continue;
          const owner = owners.get(row.ticket_id);
          if (!owner) throw failure();
          add(row.attachments, owner, row.user_id ? [owner, row.user_id] : [owner]);
        }
        return refs;
      };
      const refs = await Promise.race([work(), interrupted]);
      if (controller.signal.aborted) throw failure();
      return refs;
    } catch { throw failure(); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  };
  return {
    async list({ profileId, cursor, limit, signal }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100
        || cursor !== null && !isCanonicalErasureAttachment(cursor)) throw failure();
      const refs = await inventory(profileId, signal);
      const items = [...new Map(refs.filter(row => row.subjectId === profileId).map(row => [row.path, row])).values()]
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        .filter(row => cursor === null || row.path > cursor);
      const page = items.slice(0, limit);
      return { items: page, nextCursor: items.length > limit ? page.at(-1)!.path : null };
    },
    async classify({ profileId, paths, signal }) {
      if (paths.length > 100 || new Set(paths).size !== paths.length || paths.some(path => !isCanonicalErasureAttachment(path))) {
        throw failure();
      }
      const refs = await inventory(profileId, signal);
      return paths.map(path => {
        const owners = new Set(refs.filter(row => row.path === path).map(row => row.subjectId));
        // Legacy injected callers remain conservative; the wired executor uses
        // scopedManifest.ts with SQL-backed history and uploader-drain proof.
        const state = owners.size > 0 && (owners.size > 1 || !owners.has(profileId)) ? 'shared'
          : !path.startsWith(`${profileId}/`) ? 'unknown'
            : owners.size === 0 ? 'unreferenced' : 'exclusive';
        return { path, state };
      });
    },
  };
}
