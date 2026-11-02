/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
const bucket = 'ticket-attachments';
const subjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const subject = z.string().regex(subjectPattern);
const pageSchema = z.object({ paths: z.array(z.string()), nextAfterPath: z.string().nullable() }).strict();
const manifestSchema = z.object({
    items: z.array(z.object({ path: z.string(), uploaderId: subject.nullable(), subjectId: subject }).strict()),
    nextCursor: z.string().min(1).max(512).nullable(), reviewPending: z.boolean().optional(),
}).strict();
const referencesSchema = z.array(z.object({
    path: z.string(), state: z.enum(['exclusive', 'unreferenced', 'shared', 'unknown']),
}).strict());
const stateSchema = z.enum(['present', 'absent', 'unknown']);
/** Service-owned checkpoint: original key plus opaque provider continuation, never decoded. */
export function erasurePrefixCursor(value) {
    const [path, token, extra] = value.split('|');
    if (!isCanonicalErasureAttachment(path) || extra !== undefined || value.length > 17000
        || token !== undefined && !token)
        throw new Error('ERASURE_STORAGE_CURSOR_INVALID');
    return { path, ...(token === undefined ? {} : { cursor: decodeURIComponent(token) }) };
}
const limitsSchema = z.object({
    pageSize: z.number().int().min(1).max(100), maxPages: z.number().int().min(1).max(100),
    maxObjects: z.number().int().min(1).max(1000), requestTimeoutMs: z.number().int().min(1).max(30_000),
    totalTimeoutMs: z.number().int().min(1).max(55_000),
}).strict();
const FAILURE_CODES = new Set(['ERASURE_STORAGE_BUDGET', 'ERASURE_STORAGE_UNKNOWN', 'ERASURE_STORAGE_PAGE_INVALID',
    'ERASURE_STORAGE_MANIFEST_INVALID', 'ERASURE_STORAGE_REFERENCES_UNKNOWN', 'ERASURE_STORAGE_CURSOR_INVALID',
    'ERASURE_MANIFEST_UNKNOWN', 'ERASURE_STORAGE_UNPROVEN', 'ERASURE_HISTORY_UNKNOWN', 'ERASURE_PROOF_UNKNOWN']);
export function erasureStorageFailureCode(error) {
    if (error instanceof z.ZodError)
        return 'ERASURE_STORAGE_SHAPE_INVALID';
    return error instanceof Error && FAILURE_CODES.has(error.message) ? error.message : 'ERASURE_STORAGE_FAILED';
}
/** Exactly one UUID directory and one safe ASCII filename. Never decode or normalize a URL,
 * percent escape, backslash or traversal into an apparently owned object. */
export function isCanonicalErasureAttachment(path) {
    const parts = path.split('/');
    return parts.length === 2 && subjectPattern.test(parts[0])
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(parts[1]) && !parts[1].includes('..');
}
/** No SDK, environment, persistence or automatic caller. complete only covers this trusted
 * manifest and observed prefix scan. It is NOT proof that uploads/references are quiescent;
 * the host must establish that separate prerequisite before completing account erasure.
 * remaining is a conservative lower bound (one when enumeration/verification is unfinished). */
export function createErasureStorageAdapter(input) {
    const limits = limitsSchema.parse({ pageSize: 50, maxPages: 10, maxObjects: 200,
        requestTimeoutMs: 5_000, totalTimeoutMs: 30_000, ...input.limits });
    return { async cleanSubject(profileId) {
            subject.parse(profileId);
            const deadline = performance.now() + limits.totalTimeoutMs;
            const seen = new Set();
            const unresolved = new Set();
            let pages = 0;
            let manualReview = 0;
            let incomplete = false;
            let failure;
            const call = async (operation) => {
                const duration = Math.min(limits.requestTimeoutMs, deadline - performance.now());
                if (duration <= 0)
                    throw new Error('ERASURE_STORAGE_BUDGET');
                const controller = new AbortController();
                let timer;
                try {
                    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
                            timer = setTimeout(() => { controller.abort(); reject(new Error('ERASURE_STORAGE_UNKNOWN')); }, duration);
                        })]);
                }
                finally {
                    if (timer !== undefined)
                        clearTimeout(timer);
                }
            };
            const nextPage = () => {
                if (++pages > limits.maxPages || performance.now() >= deadline)
                    throw new Error('ERASURE_STORAGE_BUDGET');
            };
            const process = async (candidates) => {
                const unique = [...new Map(candidates.map(candidate => [candidate.path, candidate])).values()]
                    .filter(candidate => !seen.has(candidate.path));
                if (seen.size + unique.length > limits.maxObjects)
                    throw new Error('ERASURE_STORAGE_BUDGET');
                for (const candidate of unique)
                    seen.add(candidate.path);
                if (!unique.length)
                    return;
                const paths = unique.map(candidate => candidate.path);
                const references = referencesSchema.parse(await call(signal => input.manifest.classify({ profileId, paths, signal })));
                if (references.length !== paths.length || new Set(references.map(row => row.path)).size !== paths.length
                    || references.some(row => !paths.includes(row.path)))
                    throw new Error('ERASURE_STORAGE_REFERENCES_UNKNOWN');
                const deletable = [];
                for (const candidate of unique) {
                    const state = references.find(row => row.path === candidate.path).state;
                    if (state === 'exclusive' || state === 'unreferenced' && !candidate.fromManifest)
                        deletable.push(candidate.path);
                    else {
                        manualReview++;
                        unresolved.add(candidate.path);
                    }
                }
                const present = [];
                for (const path of deletable) {
                    // A manifest survives deletion. Read first so a resumed invocation inspects an
                    // earlier uncertain result instead of blindly repeating its external mutation.
                    const state = stateSchema.parse(await call(signal => input.storage.getState({ bucket, path, signal })));
                    if (state === 'present')
                        present.push(path);
                    else if (state === 'unknown') {
                        incomplete = true;
                        manualReview++;
                        unresolved.add(path);
                    }
                }
                if (!present.length)
                    return;
                // A timeout may mean deletion succeeded. Stop; the next invocation inventories and verifies afresh.
                await call(signal => input.storage.remove({ bucket, paths: present, signal }));
                for (const path of present) {
                    const state = stateSchema.parse(await call(signal => input.storage.getState({ bucket, path, signal })));
                    if (state !== 'absent') {
                        incomplete = true;
                        unresolved.add(path);
                        if (state === 'unknown')
                            manualReview++;
                    }
                }
            };
            try {
                const progress = input.manifest.prefixState ? await call(signal => input.manifest.prefixState({ profileId, signal })) : null;
                let afterPath = progress?.cursor ?? null;
                if (afterPath !== null && progress?.review)
                    manualReview++;
                let prefixPages = 0;
                const prefixBudget = progress ? Math.max(1, Math.floor(limits.maxPages / 2)) : limits.maxPages;
                if (!progress?.done)
                    do {
                        if (++prefixPages > prefixBudget) {
                            incomplete = true;
                            break;
                        }
                        nextPage();
                        const page = pageSchema.parse(await call(signal => input.storage.listPrefix({
                            bucket, prefix: `${profileId}/`, afterPath, limit: limits.pageSize, signal,
                        })));
                        if (page.paths.length > limits.pageSize || page.paths.some((path, index) => (index > 0 && path <= page.paths[index - 1]) || (afterPath !== null && path <= erasurePrefixCursor(afterPath).path))
                            || (page.nextAfterPath !== null && (!page.paths.length || erasurePrefixCursor(page.nextAfterPath).path !== page.paths.at(-1)))) {
                            throw new Error('ERASURE_STORAGE_PAGE_INVALID');
                        }
                        let prefixReview = false;
                        const candidates = page.paths.filter(path => {
                            if (isCanonicalErasureAttachment(path) && path.startsWith(`${profileId}/`))
                                return true;
                            manualReview++;
                            prefixReview = true;
                            return false;
                        });
                        await process(candidates.map(path => ({ path, fromManifest: false })));
                        if (input.manifest.checkpointPrefix)
                            await call(signal => input.manifest.checkpointPrefix({
                                profileId, nextCursor: page.nextAfterPath, review: prefixReview || page.paths.some(path => unresolved.has(path)), signal,
                            }));
                        afterPath = page.nextAfterPath;
                    } while (afterPath !== null);
                let cursor = null;
                const cursors = new Set();
                do {
                    nextPage();
                    const page = manifestSchema.parse(await call(signal => input.manifest.list({
                        profileId, cursor, limit: limits.pageSize, signal,
                    })));
                    if (page.items.length > limits.pageSize || (page.nextCursor !== null &&
                        (!page.items.length || cursors.has(page.nextCursor))))
                        throw new Error('ERASURE_STORAGE_MANIFEST_INVALID');
                    let pageReview = false;
                    if (page.reviewPending)
                        manualReview++;
                    const candidates = page.items.filter(item => {
                        if (item.uploaderId !== null && item.subjectId === profileId && isCanonicalErasureAttachment(item.path)
                            && item.path.startsWith(`${item.uploaderId}/`))
                            return true;
                        manualReview++;
                        pageReview = true;
                        return false;
                    });
                    await process(candidates.map(item => ({ path: item.path, fromManifest: true })));
                    if (input.manifest.checkpoint)
                        await call(signal => input.manifest.checkpoint({
                            profileId, nextCursor: page.nextCursor, review: pageReview || page.items.some(item => unresolved.has(item.path)), signal,
                        }));
                    cursor = page.nextCursor;
                    if (cursor !== null)
                        cursors.add(cursor);
                } while (cursor !== null);
            }
            catch (error) {
                incomplete = true;
                failure = erasureStorageFailureCode(error);
            }
            return { complete: !incomplete && manualReview === 0,
                remaining: Math.max(manualReview, incomplete ? 1 : 0), manualReview, ...(failure ? { errorCode: failure } : {}) };
        } };
}
