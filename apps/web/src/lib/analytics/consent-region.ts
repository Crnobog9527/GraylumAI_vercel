/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * ANALYTICS-CONSENT (Owner 2026-11-07): the visitor's region class decides the default for statistics. In an opt-in region
 * (EU/EEA, UK, Switzerland) nothing runs until the visitor accepts; everywhere else statistics run until the visitor turns
 * them off. The server reads the country Vercel puts on each request (`x-vercel-ip-country`) and hands the class to the
 * browser in a small first-party cookie on the same response, so no extra request is made and pages stay static.
 * A missing or unknown country counts as opt-in, the safe side. Shared by the proxy and the browser; no server-only code.
 */
export type ConsentRegion = 'optin' | 'optout';

/** EU member states and their outermost regions that carry their own code, the rest of the EEA, the UK (and its crown
 * dependencies and Gibraltar, whose laws follow the UK GDPR) and Switzerland. Listing a place here only makes it stricter. */
const OPT_IN_COUNTRIES = new Set([
  // EU 27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL',
  'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EU outermost regions and Åland with their own ISO codes
  'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'AX',
  // Rest of the EEA
  'IS', 'LI', 'NO',
  // United Kingdom, crown dependencies, Gibraltar
  'GB', 'GG', 'JE', 'IM', 'GI',
  // Switzerland
  'CH',
]);

const COUNTRY = /^[A-Z]{2}$/;

export function regionForCountry(country: string | null | undefined): ConsentRegion {
  const code = country?.trim().toUpperCase() ?? '';
  // Vercel sends a two-letter code; anything else (missing, "XX", a private address in development) is unknown: opt-in.
  if (!COUNTRY.test(code) || code === 'XX') return 'optin';
  return OPT_IN_COUNTRIES.has(code) ? 'optin' : 'optout';
}

/** The cookie the proxy writes and the browser reads. Values: `optin`, `optout`, or `test-optin` / `test-optout` for a test
 * override (non-production only). It holds the region class and nothing else: no identifier, no choice. */
export const REGION_COOKIE = 'gl_consent_region';
/** `?consent_region=optin|optout` pins the class on this browser for a test; `auto` goes back to the country. */
export const REGION_OVERRIDE_PARAM = 'consent_region';
export const REGION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type RegionCookie = { region: ConsentRegion; test: boolean };

export function parseRegionCookie(value: string | null | undefined): RegionCookie | null {
  switch (value) {
    case 'optin': return { region: 'optin', test: false };
    case 'optout': return { region: 'optout', test: false };
    case 'test-optin': return { region: 'optin', test: true };
    case 'test-optout': return { region: 'optout', test: true };
    default: return null;
  }
}

export function formatRegionCookie({ region, test }: RegionCookie): string {
  return test ? `test-${region}` : region;
}

type Env = Record<string, string | undefined>;

function isStagingAppUrl(value: string | undefined): boolean {
  try {
    return new URL(value ?? '').hostname.split('.').some(label => label.split('-').includes('staging'));
  } catch {
    return false;
  }
}

/** The test override works only outside production: never when the app says it is production, never on a Vercel
 * production deployment unless the app says it is staging (the staging project's main deployment, whose address is
 * auth-staging.graylum.com). */
export function regionOverrideAllowed(env: Env): boolean {
  if (env.APP_ENV === 'production' || env.NEXT_PUBLIC_APP_ENV === 'production') return false;
  if (env.APP_ENV === 'staging' || env.NEXT_PUBLIC_APP_ENV === 'staging') return true;
  if (isStagingAppUrl(env.NEXT_PUBLIC_APP_URL)) return true;
  if (env.VERCEL_ENV) return env.VERCEL_ENV !== 'production';
  return env.NODE_ENV !== 'production';
}

/**
 * The cookie value this request should leave in the browser. `current` is the cookie it sent, `override` the query
 * parameter. Outside production a test value sticks until `auto`; in production a test value is replaced by the country.
 */
export function regionCookieFor(input: {
  country: string | null | undefined;
  current: string | null | undefined;
  override: string | null | undefined;
  overrideAllowed: boolean;
}): RegionCookie {
  const fromCountry: RegionCookie = { region: regionForCountry(input.country), test: false };
  if (!input.overrideAllowed) return fromCountry;
  if (input.override === 'optin' || input.override === 'optout') return { region: input.override, test: true };
  if (input.override === 'auto') return fromCountry;
  const current = parseRegionCookie(input.current);
  return current?.test ? current : fromCountry;
}
