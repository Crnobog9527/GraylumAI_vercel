/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { parseSignupAttribution, registeredUtm, type SignupAttribution } from '@repo/api/src/shared/analyticsAttribution';
import { analyticsAllowed } from './consent';
import { routeTemplate } from './routes';

/**
 * First touch for the account's first source (ANALYTICS plan §3.2, §7 PR-3 acceptance). Kept in local storage only
 * after Termly statistics consent; cleared when consent is withdrawn; sent once at sign-up only if consent is still
 * live at that moment. Registered UTM values, the referrer host and the landing route template only.
 */
const KEY = 'graylum.analytics.first-touch';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Record the first landing (once) while statistics are allowed. */
export function captureFirstTouch(href: string, referrer: string, now = Date.now()): void {
  if (!analyticsAllowed()) return;
  const store = storage();
  try {
    if (!store || store.getItem(KEY)) return;
    const url = new URL(href);
    let referrerHost: string | undefined;
    try { const ref = new URL(referrer); if (ref.origin !== url.origin) referrerHost = ref.hostname; } catch { /* none */ }
    const record = parseSignupAttribution({
      ...Object.fromEntries(registeredUtm(url.search)),
      referrer_host: referrerHost,
      landing_path: routeTemplate(url.pathname) ?? undefined,
      first_seen_at: new Date(now).toISOString(),
    }, now);
    if (record) store.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: no first source for this visitor.
  }
}

export function clearFirstTouch(): void {
  try { storage()?.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** The stored first touch to send at sign-up, only while consent is live; null otherwise. */
export function firstTouchForSignup(now = Date.now()): SignupAttribution | null {
  if (!analyticsAllowed()) return null;
  try {
    const raw = storage()?.getItem(KEY);
    return raw ? parseSignupAttribution(JSON.parse(raw), now) : null;
  } catch {
    return null;
  }
}
