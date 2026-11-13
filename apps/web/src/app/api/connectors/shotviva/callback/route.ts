/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { finishShotvivaConnect, SHOTVIVA_STATE_COOKIE } from '@repo/api/src/services/connectors/shotviva/connect';
import { INTEGRATIONS_PAGE, limitShotvivaStep, shotvivaErrorCode, shotvivaRouteContext } from '@/lib/shotviva-connect';

/** INTEGRATION-SHOTVIVA: Shotviva sends the browser here with a one-time code and the state it was given. The state must
 * match this browser's cookie for the same signed-in user; the cookie is cleared whatever the outcome. */
export async function GET(request: NextRequest) {
  const page = new URL(INTEGRATIONS_PAGE, request.nextUrl.origin);
  const done = (key: 'shotviva' | 'shotviva_error', value: string) => {
    page.searchParams.set(key, value);
    const response = NextResponse.redirect(page, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    response.cookies.set({ name: SHOTVIVA_STATE_COOKIE, value: '', path: '/api/connectors/shotviva', maxAge: 0 });
    return response;
  };
  try {
    const context = await shotvivaRouteContext(request);
    if (!context) return done('shotviva_error', 'SHOTVIVA_UNAVAILABLE');
    if (!context.profileId) {
      const login = new URL('/login', request.nextUrl.origin);
      login.searchParams.set('redirect', `${request.nextUrl.pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(login, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    await limitShotvivaStep('callback', context.profileId);
    const params = request.nextUrl.searchParams;
    await finishShotvivaConnect({ admin: context.admin, baseUrl: context.baseUrl, profileId: context.profileId,
      cookie: request.cookies.get(SHOTVIVA_STATE_COOKIE)?.value, state: params.get('state'), code: params.get('code') });
    return done('shotviva', 'connected');
  } catch (cause) {
    return done('shotviva_error', shotvivaErrorCode(cause));
  }
}
