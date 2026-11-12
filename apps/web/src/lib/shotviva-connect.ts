/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { readShotvivaRouteEnv } from '@repo/api/src/lib/envValidator';
import { checkRateLimitOrThrow } from '@repo/api/src/services/redisRateLimiter';
import { ShotvivaConnectError } from '@repo/api/src/services/connectors/shotviva/connect';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

/** INTEGRATION-SHOTVIVA: shared pieces of the connect and callback routes. */
export const INTEGRATIONS_PAGE = '/app/integrations';

export type ShotvivaRouteContext = { admin: SupabaseClient; profileId: string | null; baseUrl: string | undefined };

/** The signed-in user from the session cookie and a service client; null when the server is not configured. */
export async function shotvivaRouteContext(request: NextRequest): Promise<ShotvivaRouteContext | null> {
  const env = readShotvivaRouteEnv();
  if (!env.supabaseUrl || !env.anonKey || !env.serviceKey) return null;
  const supabase = createServerClient(env.supabaseUrl, env.anonKey, {
    cookieOptions: resolveSupabaseCookieOptions(request.nextUrl.hostname.toLowerCase()),
    cookies: { getAll: () => request.cookies.getAll(), setAll() {} },
  });
  const { data: { user } } = await supabase.auth.getUser();
  return { admin: createClient(env.supabaseUrl, env.serviceKey), profileId: user?.id ?? null, baseUrl: env.shotvivaBaseUrl };
}

/** A few connect attempts per user per window (each one may call Shotviva). */
export async function limitShotvivaStep(step: 'connect' | 'callback', profileId: string) {
  await checkRateLimitOrThrow(`shotviva-${step}:${profileId}`, 'auth');
}

/** Fixed SHOTVIVA_* codes for the page; anything else is a generic code, never the error text. */
export function shotvivaErrorCode(cause: unknown): string {
  if (cause instanceof ShotvivaConnectError) return cause.code;
  // The rate limiter throws a TRPCError: TOO_MANY_REQUESTS when over the limit, SERVICE_UNAVAILABLE when it cannot check.
  if ((cause as { code?: unknown } | null)?.code === 'TOO_MANY_REQUESTS') return 'SHOTVIVA_BUSY';
  return 'SHOTVIVA_UNAVAILABLE';
}
