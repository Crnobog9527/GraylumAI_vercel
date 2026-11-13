/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse, type NextRequest } from 'next/server';
import { fetchJobImage } from '@repo/api/src/services/connectors/shotviva/images';
import { shotvivaRouteContext } from '@/lib/shotviva-connect';
import { cardImage } from '@/lib/integrations/shotviva-card-image';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** INTEGRATION-SHOTVIVA: the image of the signed-in user's own Shotviva job, for the card under a reply. Through Graylum so the page's
 * CSP stays as it is and the signed address never reaches the browser; sized for the card (cardImage). A finished job's image never
 * changes, so the browser keeps it for this user only (private) and does not ask again (immutable, one year). */
const CARD_CACHE = 'private, max-age=31536000, immutable';
export async function GET(request: NextRequest) {
  const job = request.nextUrl.searchParams.get('job') ?? '';
  if (!UUID.test(job)) return new NextResponse(null, { status: 400 });
  try {
    const context = await shotvivaRouteContext(request);
    if (!context) return new NextResponse(null, { status: 503 });
    if (!context.profileId) return new NextResponse(null, { status: 401 });
    const image = await fetchJobImage({ admin: context.admin, baseUrl: context.baseUrl, profileId: context.profileId, jobId: job });
    if (!image.ok) return new NextResponse(null, { status: image.status, headers: { 'Cache-Control': 'no-store' } });
    const card = await cardImage(image.bytes, image.contentType);
    return new NextResponse(card.bytes as BodyInit, { status: 200, headers: { 'Content-Type': card.contentType,
      'Cache-Control': CARD_CACHE, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
  } catch {
    return new NextResponse(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
