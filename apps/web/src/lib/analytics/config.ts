/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Public analytics settings (ANALYTICS plan §3, §8). Every value comes from the environment and is inlined
 * at build time; when a value is missing or malformed that part stays off: no script is loaded and nothing
 * is sent, and pages work as before. None of these are secrets (they appear in the page source).
 */
export type VercelAnalyticsCategory = 'essential' | 'analytics';

export type AnalyticsConfig = {
  /** Termly website UUID (Termly dashboard → website settings). */
  termlyWebsiteUuid: string | null;
  /** GA4 measurement ID, `G-…`; staging and production use different properties. */
  gaMeasurementId: string | null;
  /** How Termly classifies Vercel Web Analytics and Speed Insights (plan O5). Default: analytics. */
  vercelCategory: VercelAnalyticsCategory;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GA_MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;

export function parseAnalyticsConfig(env: Record<string, string | undefined>): AnalyticsConfig {
  const termly = env.NEXT_PUBLIC_TERMLY_WEBSITE_UUID?.trim() ?? '';
  const ga = env.NEXT_PUBLIC_GA4_MEASUREMENT_ID?.trim() ?? '';
  return {
    termlyWebsiteUuid: UUID.test(termly) ? termly.toLowerCase() : null,
    gaMeasurementId: GA_MEASUREMENT_ID.test(ga) ? ga : null,
    vercelCategory: env.NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY?.trim() === 'essential' ? 'essential' : 'analytics',
  };
}

// A bundle built without Next.js (component tests) has no `process`: read as unset there.
const fromEnv = (read: () => string | undefined) => {
  try { return read(); } catch { return undefined; }
};

// Written out one by one so Next.js inlines each NEXT_PUBLIC_ value into the client bundle.
export const ANALYTICS_CONFIG: AnalyticsConfig = parseAnalyticsConfig({
  NEXT_PUBLIC_TERMLY_WEBSITE_UUID: fromEnv(() => process.env.NEXT_PUBLIC_TERMLY_WEBSITE_UUID),
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: fromEnv(() => process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID),
  NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY: fromEnv(() => process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY),
});

/** Termly's resource blocker with automatic blocking off (plan O1 option A): it loads asynchronously and releases
 * scripts we classify by hand (`type="text/plain" data-categories="analytics"`) once the visitor's consent allows. */
export function termlyScriptUrl(uuid: string): string {
  return `https://app.termly.io/resource-blocker/${uuid}?autoBlock=off`;
}

export function gtagScriptUrl(measurementId: string): string {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
}
