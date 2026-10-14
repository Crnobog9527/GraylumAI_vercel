/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { connectCaller, connectCookie, errorCode, sameOrigin } from '@/lib/publish-monitor-connect';

/** Starts a Post for Me connection and binds it to this browser with an httpOnly cookie (plan §4.1). */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'PUBLISH_MONITOR_REQUEST_INVALID' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const caller = await connectCaller(request);
  if (!caller) return NextResponse.json({ error: 'MAINTENANCE' }, { status: 503 });
  try {
    const started = await caller.start(body);
    const response = NextResponse.json({ url: started.url, combinedAuthorization: started.combinedAuthorization });
    response.cookies.set(connectCookie(started.requestId, request.nextUrl.protocol === 'https:'));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (cause) {
    const code = errorCode(cause);
    const status = code === 'LOGIN_REQUIRED' ? 401 : code === 'PUBLISH_MONITOR_PROVIDER_BUSY' ? 429
      : code === 'PUBLISH_MONITOR_UNAVAILABLE' || code === 'PUBLISH_MONITOR_PROVIDER_UNAVAILABLE' ? 503 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
