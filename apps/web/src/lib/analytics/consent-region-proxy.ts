/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { NextRequest, NextResponse } from 'next/server';
import { isProductionSite, PRODUCTION_SITE_HOSTS } from '@repo/api/src/shared/productionSite';
import {
  formatRegionCookie, REGION_COOKIE, REGION_COOKIE_MAX_AGE, REGION_OVERRIDE_PARAM, regionCookieFor,
} from './consent-region';

type Env = Record<string, string | undefined>;

/**
 * The `?consent_region=` test override works only off the production site, judged on the server with the same rule the
 * payment notices use (isProductionSite). Refused also, as a second lock, when the app says it is production, when this
 * deployment belongs to the production project (any branch), or when the request is for a production domain.
 */
export function regionOverrideAllowed(env: Env, host: string): boolean {
  if (env.APP_ENV === 'production' || env.NEXT_PUBLIC_APP_ENV === 'production') return false;
  if (isProductionSite(env)) return false;
  if (PRODUCTION_SITE_HOSTS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '')) return false;
  const name = host.toLowerCase().replace(/\.$/, '');
  return !PRODUCTION_SITE_HOSTS.has(name) && name !== 'graylum.com';
}

/**
 * ANALYTICS-CONSENT: leaves the visitor's region class (consent-region.ts) in a first-party cookie on whatever response the
 * proxy returns, so the page's own script reads it without another request and the page itself stays static. Written only
 * when the value changes. Readable by the page's script on purpose (not HttpOnly): it carries only `optin` or `optout`.
 */
export function withConsentRegion<T extends NextResponse>(request: NextRequest, response: T, env: Env = process.env): T {
  const current = request.cookies.get(REGION_COOKIE)?.value ?? null;
  const next = formatRegionCookie(regionCookieFor({
    country: request.headers.get('x-vercel-ip-country'),
    current,
    override: request.nextUrl.searchParams.get(REGION_OVERRIDE_PARAM),
    overrideAllowed: regionOverrideAllowed(env, request.nextUrl.hostname),
  }));
  if (next === current) return response;
  response.cookies.set(REGION_COOKIE, next, {
    path: '/',
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    httpOnly: false,
    maxAge: REGION_COOKIE_MAX_AGE,
  });
  return response;
}
