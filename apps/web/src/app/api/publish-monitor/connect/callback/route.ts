/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { boundRequestId } from '@repo/api/src/services/publishMonitor/connectFlow';
import { CONFIRM_PAGE, connectCaller, errorCode } from '@/lib/publish-monitor-connect';

/**
 * Post for Me sends the browser here after the platform consent screen. Its query (accountIds, isSuccess) is only a
 * hint: the attempt comes from this browser's cookie and every account is re-read from the provider (plan §4.1).
 */
export async function GET(request: NextRequest) {
  const page = new URL(CONFIRM_PAGE, request.nextUrl.origin);
  const fail = (code: string) => {
    page.searchParams.set('error', code);
    return NextResponse.redirect(page, { headers: { 'Cache-Control': 'no-store' } });
  };
  const requestId = boundRequestId(request.headers.get('cookie'));
  if (!requestId) return fail('PUBLISH_MONITOR_REQUEST_INVALID');
  const params = request.nextUrl.searchParams;
  const accountIds = params.getAll('accountIds').flatMap(value => value.split(',')).map(id => id.trim())
    .filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(0, 200);
  const caller = await connectCaller(request);
  if (!caller) return fail('MAINTENANCE');
  try {
    // Recorded even when the provider reports failure, so anything it imported is still settled (plan §4.1).
    await caller.callback({ requestId, accountIds });
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'LOGIN_REQUIRED') {
      const login = new URL('/login', request.nextUrl.origin);
      login.searchParams.set('redirect', `${request.nextUrl.pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(login);
    }
    return fail(code);
  }
  page.searchParams.set('request', requestId);
  if (params.get('isSuccess') === 'false') page.searchParams.set('provider', 'failed');
  return NextResponse.redirect(page, { headers: { 'Cache-Control': 'no-store' } });
}
