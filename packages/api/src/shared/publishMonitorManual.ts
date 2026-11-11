/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR manual import: the plain limits the browser's table import needs as well as the server. No imports
 * on purpose: a page that reads one of these numbers must not download the server's validation code (zod) with it.
 * The server's rules stay in services/publishMonitor/manualImport.ts, which builds on these values.
 */

/** Metrics a manual row may carry: counts, plus completion rate as a percentage (0-100). Blank means absent. */
export const MANUAL_METRICS = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves',
  'followers_gained', 'profile_visits', 'completion_rate'] as const;
export type ManualMetric = (typeof MANUAL_METRICS)[number];
export const MAX_ROWS_PER_CALL = 200;
/** Largest metric value accepted (an accidental extra digit beyond this is refused). */
export const MAX_METRIC_VALUE = 1e12;
