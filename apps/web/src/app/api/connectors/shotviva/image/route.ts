/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { fetchJobImage } from '@repo/api/src/services/connectors/shotviva/images';
import { shotvivaRouteContext } from '@/lib/shotviva-connect';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** INTEGRATION-SHOTVIVA: the image of the signed-in user's own Shotviva job, for the card under a reply. Through Graylum so the page's
 * CSP stays as it is and the signed address never reaches the browser; private to this user and cached briefly. */
export async function GET(request: NextRequest) {
  const job = request.nextUrl.searchParams.get('job') ?? '';
  if (!UUID.test(job)) return new NextResponse(null, { status: 400 });
  try {
    const context = await shotvivaRouteContext(request);
    if (!context) return new NextResponse(null, { status: 503 });
    if (!context.profileId) return new NextResponse(null, { status: 401 });
    const image = await fetchJobImage({ admin: context.admin, baseUrl: context.baseUrl, profileId: context.profileId, jobId: job });
    if (!image.ok) return new NextResponse(null, { status: image.status, headers: { 'Cache-Control': 'no-store' } });
    return new NextResponse(image.bytes as BodyInit, { status: 200, headers: { 'Content-Type': image.contentType,
      'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
  } catch {
    return new NextResponse(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
