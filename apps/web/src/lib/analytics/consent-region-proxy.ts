/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { NextRequest, NextResponse } from 'next/server';
import {
  formatRegionCookie, REGION_COOKIE, REGION_COOKIE_MAX_AGE, REGION_OVERRIDE_PARAM, regionCookieFor, regionOverrideAllowed,
} from './consent-region';

/**
 * ANALYTICS-CONSENT: leaves the visitor's region class (consent-region.ts) in a first-party cookie on whatever response the
 * proxy returns, so the page's own script reads it without another request and the page itself stays static. Written only
 * when the value changes. Readable by the page's script on purpose (not HttpOnly): it carries only `optin` or `optout`.
 */
export function withConsentRegion<T extends NextResponse>(request: NextRequest, response: T): T {
  const current = request.cookies.get(REGION_COOKIE)?.value ?? null;
  const next = formatRegionCookie(regionCookieFor({
    country: request.headers.get('x-vercel-ip-country'),
    current,
    override: request.nextUrl.searchParams.get(REGION_OVERRIDE_PARAM),
    overrideAllowed: regionOverrideAllowed(process.env),
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
