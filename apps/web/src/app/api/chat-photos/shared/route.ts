/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { readSupabaseRouteEnv } from '@repo/api/src/lib/envValidator';
import { fetchGrantedPhoto } from '@repo/api/src/services/chatPhotos/grant';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** INTEGRATION-SHOTVIVA: one chat photo, for Shotviva's server to fetch while it makes an image (photoGrantUrl). No sign-in:
 * the few-minutes signed Storage token in the address is the permission, and Storage checks it (signature, path, expiry). Never
 * cached, never redirected (Shotviva refuses redirects), only the photo bucket's own names. */
export async function GET(request: NextRequest) {
  const { url } = readSupabaseRouteEnv();
  if (!url) return new NextResponse(null, { status: 503, headers: NO_STORE });
  const params = request.nextUrl.searchParams;
  const photo = await fetchGrantedPhoto({ supabaseUrl: url, path: params.get('p'), token: params.get('t') });
  if (!photo.ok) return new NextResponse(null, { status: photo.status, headers: NO_STORE });
  return new NextResponse(photo.bytes as BodyInit, { status: 200, headers: { ...NO_STORE, 'Content-Type': 'image/jpeg',
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Referrer-Policy': 'no-referrer' } });
}
