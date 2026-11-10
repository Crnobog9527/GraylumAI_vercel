/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { analyticsAllowed } from './consent';
import type { VercelAnalyticsCategory } from './config';
import { sanitizePageUrl } from './sanitize';

/**
 * Vercel Web Analytics and Speed Insights (ANALYTICS plan §3.3, ANALYTICS-CONSENT). Web Analytics sets no cookie and
 * keeps no identifier, so its page views are recorded for every visitor in every region (Owner 2026-11-07). Speed
 * Insights stays as before: it follows statistics consent unless `NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY=essential`.
 * Both scripts stay running once injected, so every event is checked here: dropped when it needs consent and consent is
 * not live right now, or when the page must not be reported; otherwise the address is reduced to its route template.
 */
export type VercelTool = 'web-analytics' | 'speed-insights';

export function vercelMayReport(tool: VercelTool, speedInsightsCategory: VercelAnalyticsCategory): boolean {
  if (tool === 'web-analytics' || speedInsightsCategory === 'essential') return true;
  return analyticsAllowed();
}

export function cleanVercelEvent<T extends { url: string; route?: string }>(
  event: T,
  tool: VercelTool,
  speedInsightsCategory: VercelAnalyticsCategory,
): T | null {
  if (!vercelMayReport(tool, speedInsightsCategory)) return null;
  const url = sanitizePageUrl(event.url);
  if (!url) return null;
  const cleaned = { ...event, url };
  if ('route' in event) cleaned.route = new URL(url).pathname;
  return cleaned;
}
