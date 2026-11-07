/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

type Env = Record<string, string | undefined>;

/** The production site's own domains. */
export const PRODUCTION_SITE_HOSTS: ReadonlySet<string> = new Set(['www.graylum.com', 'app.graylum.com']);

/**
 * The approved production site: a Vercel production deployment of `main` whose project's production domain is one of
 * ours. Anything else (staging, previews, local runs, a rebound or unknown project) is not. Used by the payment notices
 * (PAY-NOTIFY §7: only production may mail any user) and the consent region test override (ANALYTICS-CONSENT).
 * No server-only imports, so the web proxy can use it too.
 */
export function isProductionSite(env: Env): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production' && env.VERCEL_GIT_COMMIT_REF === 'main'
    && PRODUCTION_SITE_HOSTS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '');
}
