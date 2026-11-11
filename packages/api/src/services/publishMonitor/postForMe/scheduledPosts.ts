/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { call, type ClientDeps, type Outcome } from './client';
import { publicHttpsUrl } from './http';
import { type ProviderPostStatus, utcInstant } from './posts';

/**
 * PUBLISH-SCHEDULE: reading, moving and cancelling one scheduled Post for Me post (OpenAPI GET/PUT/DELETE
 * /v1/social-posts/{id}, open-source API checked 2026-11-11). Post for Me's update replaces the whole post (it deletes
 * and re-creates it under the same id) and is allowed until the post is processed, so callers only move a post that
 * they just read as "scheduled" and that is more than 10 minutes away. Delete is refused (400) once sending started.
 * The post body passes through this module only: caption and media URLs are never logged, stored or returned upward
 * except to send them back unchanged.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const mediaShape = z.object({
  url: z.string().max(2048), thumbnail_url: z.string().max(2048).nullable().optional(),
  thumbnail_timestamp_ms: z.number().int().min(0).nullable().optional(), alt_text: z.string().max(2000).nullable().optional(),
  tags: z.array(z.unknown()).max(50).nullable().optional(), skip_processing: z.boolean().nullable().optional(),
  index: z.number().nullable().optional(),
}).passthrough();
const postShape = z.object({
  id: z.string().regex(ID), external_id: z.string().nullable().optional(), caption: z.string().max(100_000),
  status: z.enum(['draft', 'scheduled', 'processing', 'processed']), scheduled_at: z.string().nullable().optional(),
  social_accounts: z.array(z.union([z.string().regex(ID), z.object({ id: z.string().regex(ID) }).passthrough()])).max(20),
  media: z.array(mediaShape).max(20).nullable().optional(),
  platform_configurations: z.unknown().optional(), account_configurations: z.unknown().optional(),
}).passthrough();

export type ScheduledPost = {
  id: string; externalId: string | null; status: ProviderPostStatus; scheduledAt: string | null;
  socialAccountIds: string[]; mediaCount: number;
  /** Graylum never sets per-platform or per-account overrides; a post that has them is not moved by us. */
  hasOverrides: boolean;
  /** What a full-replacement update must send back unchanged (never logged). */
  body: { caption: string; media: Array<Record<string, unknown>> };
};

const empty = (value: unknown) => value === null || value === undefined
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && Object.values(value as Record<string, unknown>).every(v => v === null || v === undefined));

function parsePost(json: unknown): ScheduledPost | null {
  const parsed = postShape.safeParse(json);
  if (!parsed.success) return null;
  const post = parsed.data;
  const scheduledAt = post.scheduled_at && Number.isFinite(Date.parse(post.scheduled_at))
    ? new Date(Date.parse(post.scheduled_at)).toISOString() : null;
  const media = (post.media ?? []).map(item => {
    const url = publicHttpsUrl(item.url);
    if (!url) return null;
    const thumb = item.thumbnail_url ? publicHttpsUrl(item.thumbnail_url) : null;
    return { url, ...(thumb ? { thumbnail_url: thumb } : {}),
      ...(typeof item.thumbnail_timestamp_ms === 'number' ? { thumbnail_timestamp_ms: item.thumbnail_timestamp_ms } : {}),
      ...(item.alt_text ? { alt_text: item.alt_text } : {}), ...(item.tags ? { tags: item.tags } : {}),
      ...(typeof item.skip_processing === 'boolean' ? { skip_processing: item.skip_processing } : {}),
      ...(typeof item.index === 'number' ? { index: item.index } : {}) };
  });
  if (media.some(item => item === null)) return null;
  return {
    id: post.id, externalId: post.external_id ?? null, status: post.status, scheduledAt,
    socialAccountIds: post.social_accounts.map(entry => typeof entry === 'string' ? entry : entry.id).sort(),
    mediaCount: media.length,
    hasOverrides: !empty(post.platform_configurations) || !empty(post.account_configurations),
    body: { caption: post.caption, media: media as Array<Record<string, unknown>> },
  };
}

function assertId(id: string) {
  if (!ID.test(id)) throw new Error('POSTFORME_POST_ID_INVALID');
}

export function getScheduledPost(deps: ClientDeps, providerPostId: string): Promise<Outcome<ScheduledPost>> {
  assertId(providerPostId);
  return call(deps, { method: 'GET', path: `/social-posts/${providerPostId}` }, parsePost);
}

/**
 * Moves a post just read as `post` to `scheduledAt`, sending everything else back unchanged. No retry: any answer but
 * a definite rejection is "unknown" and the caller verifies by reading the post again.
 */
export function moveScheduledPost(deps: ClientDeps, post: ScheduledPost, externalId: string,
  scheduledAt: string): Promise<Outcome<ScheduledPost>> {
  assertId(post.id);
  return call(deps, { method: 'PUT', path: `/social-posts/${post.id}`, body: {
    caption: post.body.caption, social_accounts: post.socialAccountIds, external_id: externalId,
    scheduled_at: utcInstant(scheduledAt), ...(post.body.media.length > 0 ? { media: post.body.media } : {}),
  } }, parsePost);
}

/** Deletes a scheduled post. 400 means sending already started; 404 that the post no longer exists. */
export function deleteScheduledPost(deps: ClientDeps, providerPostId: string): Promise<Outcome<true>> {
  assertId(providerPostId);
  return call(deps, { method: 'DELETE', path: `/social-posts/${providerPostId}` }, json => {
    const parsed = z.object({ success: z.boolean() }).passthrough().safeParse(json);
    return parsed.success && parsed.data.success ? true as const : null;
  });
}
