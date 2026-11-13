/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { readSupabaseRouteEnv } from '@repo/api/src/lib/envValidator';
import { readOwnPhoto } from '@repo/api/src/services/chatPhotos/photos';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };
/** A photo's name is unique and its bytes never change: this browser keeps it, for this user only. */
const KEEP = 'private, max-age=31536000, immutable';

/** Chat photos (Owner 2026-11-13: "照片只有本人能看"): one of the signed-in user's own photos, shown with its message. The user is the
 * session cookie's; a photo of another account is not found, whatever the address says. */
export async function GET(request: NextRequest) {
  const { url, anonKey, serviceKey } = readSupabaseRouteEnv();
  if (!url || !anonKey || !serviceKey) return new NextResponse(null, { status: 503, headers: NO_STORE });
  try {
    const supabase = createServerClient(url, anonKey, {
      cookieOptions: resolveSupabaseCookieOptions(request.nextUrl.hostname.toLowerCase()),
      cookies: { getAll: () => request.cookies.getAll(), setAll() {} },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new NextResponse(null, { status: 401, headers: NO_STORE });
    const photo = await readOwnPhoto(createClient(url, serviceKey), user.id, request.nextUrl.searchParams.get('p'));
    if (!photo.ok) return new NextResponse(null, { status: photo.status, headers: NO_STORE });
    return new NextResponse(photo.bytes as BodyInit, { status: 200, headers: { 'Cache-Control': KEEP, 'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
  } catch {
    return new NextResponse(null, { status: 502, headers: NO_STORE });
  }
}
