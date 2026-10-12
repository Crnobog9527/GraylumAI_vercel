/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';

/**
 * Switches for the landing page (offer final 2026-10-13, docs/launch/design/landing/).
 * Every sentence, step, sticky note or FAQ answer that promises a capability names the capability
 * here; while that capability is not accepted on staging, the whole block stays hidden.
 *
 * To turn one on after its task is accepted: change `accepted` below in a reviewed PR.
 * For a staging or preview walk-through only, `LANDING_PREVIEW_FEATURES` (comma list, or `all`)
 * shows hidden blocks; it is ignored where SITE_INDEXING is "public", so it can never reach the
 * indexed production page.
 */
export const LANDING_FEATURES = {
  // Positioning chat: one question at a time, examples, recommended options, summary and confirm,
  // stop and resume, 24-hour availability, honest "this direction is hard to monetise".
  coach: { task: 'AGENT-CORE / CONVERSATION-DRIVEN-CAPTURE', accepted: true },
  research: { task: 'RESEARCH-TOOLS', accepted: false },
  report: { task: 'REPORT-GEN', accepted: false },
  library: { task: 'LIB-DOCS + #830', accepted: false },
  voice: { task: 'VOICE', accepted: false },
  content: { task: 'CONTENT-CONVERSATION-DRIVEN', accepted: false },
  publish: { task: 'PUBLISH-MONITOR', accepted: false },
  fusion: { task: 'FUSION-REVIEW', accepted: false },
  // Founder seats and their price need a public server answer (seat count is login-only today).
  founder: { task: 'PAY-FOUNDER', accepted: false },
  // Per-audience sample reports, generated with demo accounts once RESEARCH-TOOLS is live.
  sampleReports: { task: 'RESEARCH-TOOLS + sample reports', accepted: false },
} as const;

export type LandingFeature = keyof typeof LANDING_FEATURES;
export type LandingFlags = Record<LandingFeature, boolean>;

export const PREVIEW_ENV = 'LANDING_PREVIEW_FEATURES';

const FEATURE_KEYS = Object.keys(LANDING_FEATURES) as LandingFeature[];

/** Accepted capabilities, plus preview-only extras outside the indexed production environment. */
export function resolveLandingFlags(env: Record<string, string | undefined> = process.env): LandingFlags {
  const preview = isPublicIndexingEnabled(env[SITE_INDEXING_ENV]) ? '' : (env[PREVIEW_ENV] ?? '');
  const extra = new Set(preview.split(',').map(item => item.trim()).filter(Boolean));
  return Object.fromEntries(FEATURE_KEYS.map(key => [
    key, LANDING_FEATURES[key].accepted || extra.has('all') || extra.has(key),
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
