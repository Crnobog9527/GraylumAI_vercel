/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import {
  SHOTVIVA_STATE_COOKIE, SHOTVIVA_STATE_MAX_AGE_SECONDS, startShotvivaConnect,
} from '@repo/api/src/services/connectors/shotviva/connect';
import { limitShotvivaStep, shotvivaErrorCode, shotvivaRouteContext } from '@/lib/shotviva-connect';

/** INTEGRATION-SHOTVIVA: start connecting. Answers the Shotviva authorize URL and binds the attempt to this browser and
 * this signed-in user with an httpOnly cookie. Only a POST from a page of this site. */
export async function POST(request: NextRequest) {
  const json = (body: object, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const origin = request.headers.get('origin');
  if (origin === null || origin !== request.nextUrl.origin) return json({ error: 'SHOTVIVA_STATE_INVALID' }, 403);
  try {
    const context = await shotvivaRouteContext(request);
    if (!context) return json({ error: 'SHOTVIVA_UNAVAILABLE' }, 503);
    if (!context.profileId) return json({ error: 'LOGIN_REQUIRED' }, 401);
    await limitShotvivaStep('connect', context.profileId);
    const started = await startShotvivaConnect({ admin: context.admin, baseUrl: context.baseUrl, profileId: context.profileId,
      appOrigin: request.nextUrl.origin });
    const response = json({ url: started.redirectUrl }, 200);
    response.cookies.set({ name: SHOTVIVA_STATE_COOKIE, value: started.cookie, httpOnly: true,
      secure: request.nextUrl.protocol === 'https:', sameSite: 'lax', path: '/api/connectors/shotviva',
      maxAge: SHOTVIVA_STATE_MAX_AGE_SECONDS });
    return response;
  } catch (cause) {
    const code = shotvivaErrorCode(cause);
    const status = code === 'SHOTVIVA_MEMBERSHIP_REQUIRED' || code === 'SHOTVIVA_ACCOUNT_CLOSED' ? 403
      : code === 'SHOTVIVA_BUSY' ? 429 : 503;
    return json({ error: code }, status);
  }
}
