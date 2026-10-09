/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

const bucket = 'ticket-attachments' as const;
const subjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const subject = z.string().regex(subjectPattern);
const pageSchema = z.object({ paths: z.array(z.string()), nextAfterPath: z.string().nullable() }).strict();
const manifestSchema = z.object({
  items: z.array(z.object({ path: z.string(), uploaderId: subject, subjectId: subject }).strict()),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
const referencesSchema = z.array(z.object({
  path: z.string(), state: z.enum(['exclusive', 'unreferenced', 'shared', 'unknown']),
}).strict());
const stateSchema = z.enum(['present', 'absent', 'unknown']);
type Scoped = { bucket: typeof bucket; signal: AbortSignal };

export type ErasureStorageTransport = {
  /** Full paths, strictly increasing ASCII order. Cursor is the last path, never an offset.
   * A non-null cursor means more work; null means this prefix enumeration is exhausted. */
  listPrefix(input: Scoped & { prefix: string; afterPath: string | null; limit: number }): Promise<unknown>;
  remove(input: Scoped & { paths: string[] }): Promise<unknown>;
  /** Must read the original object identity; a failed read is unknown, never absent. */
  getState(input: Scoped & { path: string }): Promise<unknown>;
};
export type ErasureAttachmentManifest = {
  /** Trusted original attachment ownership, including administrator replies. Must survive
   * business-body cleanup until storage verification completes. Not supplied by the client.
   * Stable cursor over this manifest, unaffected by deleting storage objects. */
  list(input: { profileId: string; cursor: string | null; limit: number; signal: AbortSignal }): Promise<unknown>;
  /** Persist a verified manifest page only after every object in it was observed absent. */
  checkpoint?(input: { profileId: string; nextCursor: string | null; signal: AbortSignal }): Promise<void>;
  /** Complete cross-subject reference check for every requested path. exclusive means only
   * this subject; unreferenced means an orphan; missing/incomplete evidence means unknown.
   * The host must exclude concurrent reference writes across this check and deletion. */
  classify(input: { profileId: string; paths: string[]; signal: AbortSignal }): Promise<unknown>;
};
export type ErasureStorageLimits = {
  pageSize: number; maxPages: number; maxObjects: number; requestTimeoutMs: number; totalTimeoutMs: number;
};
const limitsSchema = z.object({
  pageSize: z.number().int().min(1).max(100), maxPages: z.number().int().min(1).max(100),
  maxObjects: z.number().int().min(1).max(1000), requestTimeoutMs: z.number().int().min(1).max(30_000),
  totalTimeoutMs: z.number().int().min(1).max(55_000),
}).strict();
export type ErasureStorageResult = { complete: boolean; remaining: number; manualReview: number };

/** Exactly one UUID directory and one safe ASCII filename. Never decode or normalize a URL,
 * percent escape, backslash or traversal into an apparently owned object. */
export function isCanonicalErasureAttachment(path: string): boolean {
  const parts = path.split('/');
  return parts.length === 2 && subjectPattern.test(parts[0])
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(parts[1]) && !parts[1].includes('..');
}

/** No SDK, environment, persistence or automatic caller. complete only covers this trusted
 * manifest and observed prefix scan. It is NOT proof that uploads/references are quiescent;
 * the host must establish that separate prerequisite before completing account erasure.
 * remaining is a conservative lower bound (one when enumeration/verification is unfinished). */
export function createErasureStorageAdapter(input: {
  storage: ErasureStorageTransport; manifest: ErasureAttachmentManifest; limits?: Partial<ErasureStorageLimits>;
}) {
  const limits = limitsSchema.parse({ pageSize: 50, maxPages: 10, maxObjects: 200,
    requestTimeoutMs: 5_000, totalTimeoutMs: 30_000, ...input.limits });
  return { async cleanSubject(profileId: string): Promise<ErasureStorageResult> {
    subject.parse(profileId);
    const deadline = performance.now() + limits.totalTimeoutMs;
    const seen = new Set<string>();
    let pages = 0;
    let manualReview = 0;
    let incomplete = false;
    const call = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const duration = Math.min(limits.requestTimeoutMs, deadline - performance.now());
      if (duration <= 0) throw new Error('ERASURE_STORAGE_BUDGET');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('ERASURE_STORAGE_UNKNOWN')); }, duration);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const nextPage = () => {
      if (++pages > limits.maxPages || performance.now() >= deadline) throw new Error('ERASURE_STORAGE_BUDGET');
    };
    const process = async (candidates: Array<{ path: string; fromManifest: boolean }>) => {
      const unique = [...new Map(candidates.map(candidate => [candidate.path, candidate])).values()]
        .filter(candidate => !seen.has(candidate.path));
      if (seen.size + unique.length > limits.maxObjects) throw new Error('ERASURE_STORAGE_BUDGET');
      for (const candidate of unique) seen.add(candidate.path);
      if (!unique.length) return;
      const paths = unique.map(candidate => candidate.path);
      const references = referencesSchema.parse(await call(signal => input.manifest.classify({ profileId, paths, signal })));
      if (references.length !== paths.length || new Set(references.map(row => row.path)).size !== paths.length
        || references.some(row => !paths.includes(row.path))) throw new Error('ERASURE_STORAGE_REFERENCES_UNKNOWN');
      const deletable: string[] = [];
      for (const candidate of unique) {
        const state = references.find(row => row.path === candidate.path)!.state;
        if (state === 'exclusive' || state === 'unreferenced' && !candidate.fromManifest) deletable.push(candidate.path);
        else manualReview++;
      }
      const present: string[] = [];
      for (const path of deletable) {
        // A manifest survives deletion. Read first so a resumed invocation inspects an
        // earlier uncertain result instead of blindly repeating its external mutation.
        const state = stateSchema.parse(await call(signal => input.storage.getState({ bucket, path, signal })));
        if (state === 'present') present.push(path);
        else if (state === 'unknown') { incomplete = true; manualReview++; }
      }
      if (!present.length) return;
      // A timeout may mean deletion succeeded. Stop; the next invocation inventories and verifies afresh.
      await call(signal => input.storage.remove({ bucket, paths: present, signal }));
      for (const path of present) {
        const state = stateSchema.parse(await call(signal => input.storage.getState({ bucket, path, signal })));
        if (state !== 'absent') { incomplete = true; if (state === 'unknown') manualReview++; }
      }
    };
    try {
      let afterPath: string | null = null;
      do {
        nextPage();
        const page = pageSchema.parse(await call(signal => input.storage.listPrefix({
          bucket, prefix: `${profileId}/`, afterPath, limit: limits.pageSize, signal,
        })));
        if (page.paths.length > limits.pageSize || page.paths.some((path, index) =>
          (index > 0 && path <= page.paths[index - 1]) || (afterPath !== null && path <= afterPath))
          || (page.nextAfterPath !== null && (!page.paths.length || page.nextAfterPath !== page.paths.at(-1)))) {
          throw new Error('ERASURE_STORAGE_PAGE_INVALID');
        }
        const candidates = page.paths.filter(path => {
          if (isCanonicalErasureAttachment(path) && path.startsWith(`${profileId}/`)) return true;
          manualReview++; return false;
        });
        await process(candidates.map(path => ({ path, fromManifest: false })));
        afterPath = page.nextAfterPath;
      } while (afterPath !== null);

      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        nextPage();
        const page = manifestSchema.parse(await call(signal => input.manifest.list({
          profileId, cursor, limit: limits.pageSize, signal,
        })));
        if (page.items.length > limits.pageSize || (page.nextCursor !== null &&
          (!page.items.length || cursors.has(page.nextCursor)))) throw new Error('ERASURE_STORAGE_MANIFEST_INVALID');
        const candidates = page.items.filter(item => {
          if (item.subjectId === profileId && isCanonicalErasureAttachment(item.path)
            && item.path.startsWith(`${item.uploaderId}/`)) return true;
          manualReview++; return false;
        });
        await process(candidates.map(item => ({ path: item.path, fromManifest: true })));
        if (incomplete || manualReview > 0) break;
        if (input.manifest.checkpoint) await call(signal => input.manifest.checkpoint!({
          profileId, nextCursor: page.nextCursor, signal,
        }));
        cursor = page.nextCursor;
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
    } catch { incomplete = true; }
    return { complete: !incomplete && manualReview === 0,
      remaining: Math.max(manualReview, incomplete ? 1 : 0), manualReview };
  } };
}
