/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';

/**
 * What the landing page promises, and the few switches it keeps (offer final 2026-10-13, docs/launch/design/landing/).
 *
 * Owner 2026-10-17 (relayed by the controller): "落地不用增加这个开关，你现在就把它按完整上线的那个版本去做就行了。" The page
 * is the full launched version: no capability can hide a block. Every sentence, step, sticky note or FAQ answer still
 * names the capabilities it promises (`needs`), as a record of what launch has to deliver, but those names are not
 * switches; this replaces the earlier plan of switching unbuilt capabilities off on 10-24.
 *
 * What stays switchable is not a capability but a fact the page must not claim before it is true: the 500 sign-up
 * credits, the founder offer's live seats, and sample reports that were really generated (never invented content).
 * For a staging or preview walk-through, `LANDING_PREVIEW_FEATURES` (comma list, or `all`) also shows those that are
 * off; it is ignored where SITE_INDEXING is "public".
 */
export const LANDING_CAPABILITIES = {
  // Positioning chat: one question at a time, examples, recommended options, summary and confirm,
  // stop and resume, 24-hour availability, honest "this direction is hard to monetise".
  coach: 'AGENT-CORE / CONVERSATION-DRIVEN-CAPTURE',
  research: 'RESEARCH-TOOLS',
  report: 'REPORT-GEN',
  library: 'LIB-DOCS + #830',
  voice: 'VOICE',
  content: 'CONTENT-CONVERSATION-DRIVEN',
  publish: 'PUBLISH-MONITOR',
  fusion: 'FUSION-REVIEW',
} as const;

export const LANDING_FEATURES = {
  // The page promises 500 sign-up credits; the grant is 500 once migration 0230 is applied (before that, 100).
  signupGrant: { task: 'PAYWALL（注册赠送 500 积分）', show: true },
  // The founder card also needs its price and seats from a public server answer; without one it stays away.
  founder: { task: 'PAY-FOUNDER', show: true },
  // The 14 sample reports (lib/landing/sample-reports): on only while sampleReportsReady() holds, i.e. every one is
  // generated with its whole text and overview (the tests check this and the privacy rule). Off hides them everywhere.
  sampleReports: { task: 'RESEARCH-TOOLS + sample reports', show: true },
} as const;

/** A capability a block promises (always shown) or one of the page's few switches. */
export type LandingCapability = keyof typeof LANDING_CAPABILITIES;
export type LandingSwitch = keyof typeof LANDING_FEATURES;
export type LandingFeature = LandingCapability | LandingSwitch;
export type LandingFlags = Record<LandingSwitch, boolean>;

export const PREVIEW_ENV = 'LANDING_PREVIEW_FEATURES';

const SWITCH_KEYS = Object.keys(LANDING_FEATURES) as LandingSwitch[];

/** The switches as set, plus preview-only extras outside the indexed production environment. */
export function resolveLandingFlags(
  env: Record<string, string | undefined> = process.env,
  /** The switches as set; only tests pass another table. */
  features: Record<LandingSwitch, { show: boolean }> = LANDING_FEATURES,
): LandingFlags {
  const preview = isPublicIndexingEnabled(env[SITE_INDEXING_ENV]) ? '' : (env[PREVIEW_ENV] ?? '');
  const extra = new Set(preview.split(',').map(item => item.trim()).filter(Boolean));
  return Object.fromEntries(SWITCH_KEYS.map(key => [
    key, features[key].show || extra.has('all') || extra.has(key),
  ])) as LandingFlags;
}

const isSwitch = (key: LandingFeature): key is LandingSwitch => key in LANDING_FEATURES;

/** A block shows unless one of the switches it names is off; capabilities never hide it. */
export function allOn(flags: LandingFlags, needs: readonly LandingFeature[] = []) {
  return needs.every(key => !isSwitch(key) || flags[key]);
}

/** Keeps the items none of whose switches is off. */
export function visibleItems<T extends { needs?: readonly LandingFeature[] }>(flags: LandingFlags, items: readonly T[]) {
  return items.filter(item => allOn(flags, item.needs));
}
