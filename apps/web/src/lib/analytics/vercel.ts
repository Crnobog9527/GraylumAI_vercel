/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { analyticsAllowed } from './consent';
import type { VercelAnalyticsCategory } from './config';
import { sanitizePageUrl } from './sanitize';

/**
 * Vercel Web Analytics and Speed Insights (ANALYTICS plan §3.3). Both scripts stay running once injected, so
 * every event is checked here: dropped when the category needs consent and Termly does not report it right
 * now, or when the page must not be reported; otherwise the address is reduced to its route template.
 */
export function vercelMayReport(category: VercelAnalyticsCategory): boolean {
  return category === 'essential' || analyticsAllowed();
}

export function cleanVercelEvent<T extends { url: string; route?: string }>(event: T, category: VercelAnalyticsCategory): T | null {
  if (!vercelMayReport(category)) return null;
  const url = sanitizePageUrl(event.url);
  if (!url) return null;
  const cleaned = { ...event, url };
  if ('route' in event) cleaned.route = new URL(url).pathname;
  return cleaned;
}
