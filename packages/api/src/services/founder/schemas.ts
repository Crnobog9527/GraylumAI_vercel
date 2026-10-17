/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { resolveAnnouncementLink } from '../../shared/announcementLink';

/**
 * PAY-FOUNDER PR-F1. Wall links are checked here before they reach the database (which checks the stored
 * form again) and once more when the public page renders them: https external addresses only, never with a
 * user name or password, normalized by URL().
 */
export function founderWallLink(value: string | null | undefined): string | null {
  const resolved = resolveAnnouncementLink(value);
  if (!resolved?.isExternal) return null;
  try {
    const url = new URL(resolved.href);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !CONTROL.test(value), 'FOUNDER_TEXT_INVALID');
const optionalText = (max: number) => z.union([text(max), z.literal('').transform(() => null), z.null()]).optional()
  .transform(value => value ?? null);
const link = z.string().max(2048).transform((value, ctx) => {
  const href = founderWallLink(value);
  if (!href) ctx.addIssue({ code: 'custom', message: 'FOUNDER_WALL_LINK_INVALID' });
  return href ?? '';
});

export const FOUNDER_WALL_PLATFORMS = ['douyin', 'xiaohongshu', 'wechat_channels', 'bilibili', 'weibo', 'kuaishou',
  'youtube', 'tiktok', 'instagram', 'x', 'facebook', 'linkedin', 'other'] as const;

export const founderWallEntryInput = z.object({
  displayName: text(40),
  socialAccounts: z.array(z.object({ platform: z.enum(FOUNDER_WALL_PLATFORMS), handle: text(60), url: link }).strict())
    .max(3).default([]),
  productName: optionalText(60),
  productUrl: z.union([link, z.literal('').transform(() => null), z.null()]).optional().transform(value => value ?? null),
  intro: optionalText(120),
}).strict().refine(entry => entry.productUrl === null || entry.productName !== null, {
  message: 'FOUNDER_WALL_PRODUCT_NAME_REQUIRED', path: ['productName'],
});
export const founderWallSubmitInput = z.object({
  entry: founderWallEntryInput,
  /** The consent wording version the member was shown and ticked (default unticked in the UI). */
  consentVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
}).strict();

const timestamp = z.string().min(1);
const nullableTimestamp = timestamp.nullable();
export const founderStatusSchema = z.object({
  state: z.enum(['none', 'active', 'grace', 'frozen', 'ended']),
  orderId: z.string().uuid().nullable(),
  foundedAt: nullableTimestamp,
  periodEnd: nullableTimestamp,
  deadline: nullableTimestamp,
  endedAt: nullableTimestamp,
  endedReason: z.enum(['refunded', 'lapsed', 'expired']).nullable(),
}).strict();
const account = z.object({ platform: z.string(), handle: z.string(), url: z.string() }).strict();
export const founderWallPublicSchema = z.array(z.object({
  displayName: z.string(), socialAccounts: z.array(account), productName: z.string().nullable(),
  productUrl: z.string().nullable(), intro: z.string().nullable(),
}).strict());
export const founderWallEntrySchema = z.object({
  displayName: z.string(), socialAccounts: z.array(account), productName: z.string().nullable(),
  productUrl: z.string().nullable(), intro: z.string().nullable(),
  reviewState: z.enum(['pending', 'approved', 'rejected']), reviewedAt: nullableTimestamp, updatedAt: timestamp,
}).strict();
export const founderMemberSchema = z.object({
  founder: founderStatusSchema,
  consent: z.object({
    purpose: z.literal('founder_wall'), currentVersion: z.string().min(1), granted: z.boolean(),
    version: z.string().nullable(), grantedAt: nullableTimestamp, revokedAt: nullableTimestamp,
  }).strict(),
  entry: founderWallEntrySchema.nullable(),
  listed: z.boolean(),
  community: z.object({ url: z.string().nullable(), note: z.string().nullable() }).strict().nullable(),
}).strict();
export type FounderMemberState = z.infer<typeof founderMemberSchema>;
export type FounderWallPublicEntry = z.infer<typeof founderWallPublicSchema>[number];
