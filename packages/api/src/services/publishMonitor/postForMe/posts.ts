/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { call, type ClientDeps, type Outcome } from './client';
import { exchange, publicHttpsUrl } from './http';

/**
 * Post for Me publishing calls (PUBLISH-MONITOR PR-5, plan §6). The create call is sent exactly once: this transport
 * never retries, and only a definite client error counts as "not created"; anything else is "unknown" and is
 * reconciled by external_id. Media URLs are passed through and never logged, returned to logs or stored.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_ID = z.string().uuid();
// Plan §6: only these synchronous answers prove the post was not created. 408/409/429 and 5xx may have been accepted.
const DEFINITE_REJECTIONS = new Set([400, 401, 403, 404, 422]);

export type CreatePostInput = {
  externalId: string; caption: string; socialAccountIds: string[]; mediaUrls: string[];
};

export type CreateOutcome =
  | { kind: 'created'; providerPostId: string }
  | { kind: 'rejected'; status: number }
  | { kind: 'unknown'; reason: string };

const postShape = z.object({ id: z.string().regex(ID), external_id: z.string().nullable().optional() }).passthrough();

/**
 * The caller must already hold a shared limiter slot (taken before the job is marked as dispatching), so a busy
 * limiter can never leave a job in "may have been sent" without a request.
 */
export async function createPost(deps: ClientDeps, input: CreatePostInput): Promise<CreateOutcome> {
  JOB_ID.parse(input.externalId);
  if (input.socialAccountIds.length < 1 || input.socialAccountIds.length > 9 || input.socialAccountIds.some(id => !ID.test(id))) {
    throw new Error('POSTFORME_ACCOUNT_ID_INVALID');
  }
  const media = input.mediaUrls.map(url => {
    const safe = publicHttpsUrl(url);
    if (!safe) throw new Error('POSTFORME_MEDIA_URL_INVALID');
    return { url: safe };
  });
  const result = await exchange({ method: 'POST', path: '/social-posts', body: {
    caption: input.caption, social_accounts: input.socialAccountIds, external_id: input.externalId,
    ...(media.length > 0 ? { media } : {}),
  } }, deps.apiKey, deps);
  if (result.kind === 'unknown') return { kind: 'unknown', reason: result.reason };
  if (DEFINITE_REJECTIONS.has(result.status)) return { kind: 'rejected', status: result.status };
  if (result.kind === 'response' && result.status >= 200 && result.status < 300) {
    const parsed = postShape.safeParse(result.json);
    if (parsed.success && (parsed.data.external_id ?? input.externalId) === input.externalId) {
      return { kind: 'created', providerPostId: parsed.data.id };
    }
    return { kind: 'unknown', reason: 'RESPONSE_SHAPE' };
  }
  return { kind: 'unknown', reason: result.kind === 'unreadable' ? result.reason : `HTTP_${result.status}` };
}

/** The provider post created for one job, found by its external_id (the job id); null when none exists yet. */
export async function findPostByExternalId(deps: ClientDeps, externalId: string): Promise<Outcome<string | null>> {
  JOB_ID.parse(externalId);
  const query = new URLSearchParams({ external_id: externalId, limit: '2', offset: '0' });
  const found = await call(deps, { method: 'GET', path: `/social-posts?${query}` }, json => {
    const parsed = z.object({ data: z.array(postShape).max(2) }).passthrough().safeParse(json);
    if (!parsed.success) return null;
    const matching = parsed.data.data.filter(post => post.external_id === externalId);
    // Two posts for one job would mean it was sent twice: refuse to guess which one to settle.
    if (matching.length > 1) return null;
    return { id: matching[0]?.id ?? null };
  });
  return found.kind === 'ok' ? { kind: 'ok', value: found.value.id } : found;
}

export type PostResult = { socialAccountId: string; success: boolean; url: string | null };
const resultShape = z.object({
  social_account_id: z.string().regex(ID), post_id: z.string().regex(ID), success: z.boolean(),
  platform_data: z.object({ url: z.unknown().optional() }).passthrough().nullable().optional(),
}).passthrough();

/** Per-account results of one provider post (at most 9 targets, one page). */
export function listPostResults(deps: ClientDeps, providerPostId: string): Promise<Outcome<PostResult[]>> {
  if (!ID.test(providerPostId)) throw new Error('POSTFORME_POST_ID_INVALID');
  const query = new URLSearchParams({ post_id: providerPostId, limit: '50', offset: '0' });
  return call(deps, { method: 'GET', path: `/social-post-results?${query}` }, json => {
    const parsed = z.object({ data: z.array(resultShape).max(50) }).passthrough().safeParse(json);
    if (!parsed.success || parsed.data.data.some(row => row.post_id !== providerPostId)) return null;
    return parsed.data.data.map(row => ({ socialAccountId: row.social_account_id, success: row.success,
      url: row.success ? publicHttpsUrl(row.platform_data?.url) : null }));
  });
}

export type UploadSlot = { uploadUrl: string; mediaUrl: string };

/** A signed, short-lived upload URL for the browser and the public media URL to post with (plan §2.1). */
export function createUploadUrl(deps: ClientDeps): Promise<Outcome<UploadSlot>> {
  return call(deps, { method: 'POST', path: '/media/create-upload-url', body: {} }, json => {
    const parsed = z.object({ upload_url: z.string(), media_url: z.string() }).passthrough().safeParse(json);
    if (!parsed.success) return null;
    const uploadUrl = publicHttpsUrl(parsed.data.upload_url, 4096);
    const mediaUrl = publicHttpsUrl(parsed.data.media_url);
    return uploadUrl && mediaUrl ? { uploadUrl, mediaUrl } : null;
  });
}
