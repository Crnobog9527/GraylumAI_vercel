/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { CONNECT_COOKIE, CONNECT_COOKIE_MAX_AGE_SECONDS } from '@repo/api/src/services/publishMonitor/connectFlow';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

/**
 * PUBLISH-MONITOR PR-2b-2: shared pieces of the start and callback routes. Both run the same tRPC procedures as the
 * app (same login, entitlement and switch checks); the routes only add the browser cookie and the redirects.
 */
export const CONFIRM_PAGE = '/app/publish-monitor/connect';

export function connectCookie(requestId: string, secure: boolean) {
  return { name: CONNECT_COOKIE, value: requestId, httpOnly: true, secure, sameSite: 'lax' as const, path: '/',
    maxAge: CONNECT_COOKIE_MAX_AGE_SECONDS };
}

/** A state-changing POST is accepted only from a page of this same site. */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === request.nextUrl.origin;
}

/** Maintenance blocks these routes the same way the tRPC route blocks ordinary procedures. */
async function maintenanceOn(): Promise<boolean> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return true;
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
  const { data, error } = await admin.from('system_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
  if (error) return true;
  return data?.value === true || data?.value === 'true';
}

export async function connectCaller(request: NextRequest) {
  if (await maintenanceOn()) return null;
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: resolveSupabaseCookieOptions(request.nextUrl.hostname.toLowerCase()),
    cookies: { getAll: () => request.cookies.getAll(), setAll() {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const ctx = await createTRPCContext({ headers: request.headers, user, supabaseAuth: supabase });
  return appRouter.createCaller(ctx).publishMonitor.connect;
}

/** tRPC error message codes are fixed PUBLISH_MONITOR_* strings; anything else becomes a generic code. */
export function errorCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  if (/^PUBLISH_MONITOR_[A-Z_]{1,60}$/.test(message)) return message;
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === 'UNAUTHORIZED') return 'LOGIN_REQUIRED';
  if (code === 'TOO_MANY_REQUESTS' || code === 'SERVICE_UNAVAILABLE') return 'PUBLISH_MONITOR_PROVIDER_BUSY';
  return 'PUBLISH_MONITOR_UNAVAILABLE';
}
