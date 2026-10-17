/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';

/**
 * Switches for the landing page (offer final 2026-10-13, docs/launch/design/landing/).
 * Every sentence, step, sticky note or FAQ answer that promises a capability names the capability here.
 * Owner 2026-10-13: the page is written for the finished product, so every capability shows by default.
 * Before launch, check each task below is really live; for one that is not, set `show: false` in a
 * reviewed PR and the blocks that promise it disappear. Sample reports stay off until they are really
 * generated (never invented content).
 *
 * For a staging or preview walk-through, `LANDING_PREVIEW_FEATURES` (comma list, or `all`) also shows
 * blocks that are off; it is ignored where SITE_INDEXING is "public".
 */
export const LANDING_FEATURES = {
  // Positioning chat: one question at a time, examples, recommended options, summary and confirm,
  // stop and resume, 24-hour availability, honest "this direction is hard to monetise".
  coach: { task: 'AGENT-CORE / CONVERSATION-DRIVEN-CAPTURE', show: true },
  research: { task: 'RESEARCH-TOOLS', show: true },
  report: { task: 'REPORT-GEN', show: true },
  library: { task: 'LIB-DOCS + #830', show: true },
  voice: { task: 'VOICE', show: true },
  content: { task: 'CONTENT-CONVERSATION-DRIVEN', show: true },
  publish: { task: 'PUBLISH-MONITOR', show: true },
  fusion: { task: 'FUSION-REVIEW', show: true },
  // The page promises 500 sign-up credits; the grant is 500 once migration 0230 is applied (before that, 100).
  signupGrant: { task: 'PAYWALL（注册赠送 500 积分）', show: true },
  // The founder card also needs its price and seats from a public server answer; without one it stays away.
  founder: { task: 'PAY-FOUNDER', show: true },
  // Per-audience sample reports, generated with demo accounts once RESEARCH-TOOLS is live.
  sampleReports: { task: 'RESEARCH-TOOLS + sample reports', show: false },
} as const;

export type LandingFeature = keyof typeof LANDING_FEATURES;
export type LandingFlags = Record<LandingFeature, boolean>;

export const PREVIEW_ENV = 'LANDING_PREVIEW_FEATURES';

const FEATURE_KEYS = Object.keys(LANDING_FEATURES) as LandingFeature[];

/** Capabilities shown by default, plus preview-only extras outside the indexed production environment. */
export function resolveLandingFlags(env: Record<string, string | undefined> = process.env): LandingFlags {
  const preview = isPublicIndexingEnabled(env[SITE_INDEXING_ENV]) ? '' : (env[PREVIEW_ENV] ?? '');
  const extra = new Set(preview.split(',').map(item => item.trim()).filter(Boolean));
  return Object.fromEntries(FEATURE_KEYS.map(key => [
    key, LANDING_FEATURES[key].show || extra.has('all') || extra.has(key),
  ])) as LandingFlags;
}

/** A block shows only when every capability it promises is on. */
export function allOn(flags: LandingFlags, needs: readonly LandingFeature[] = []) {
  return needs.every(key => flags[key]);
}

/** Keeps the items whose capabilities are all on. */
export function visibleItems<T extends { needs?: readonly LandingFeature[] }>(flags: LandingFlags, items: readonly T[]) {
  return items.filter(item => allOn(flags, item.needs));
}
