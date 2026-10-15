import { after, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { advanceAuthorized, advanceRequest, advanceReview, kickAdvance, MAX_HOPS } from '@repo/api/src/services/fusion/background';
import { logger } from '@repo/api/src/services';

export const runtime = 'nodejs';
// One review step per invocation (FUSION-BACKGROUND): the step runs after the response, within this limit.
export const maxDuration = 300;

/** Internal relay of the review background (FUSION-BACKGROUND). Only POST, only with the server secret (compared in
 * constant time; headers are never logged), only a review id and a hop number. Answers 202 at once; the step runs
 * after the response and, when it advanced, asks a fresh invocation for the next step. */
export async function POST(request: Request) {
  if (!advanceAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let input;
  try { input = advanceRequest.parse(await request.json()); }
  catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 503 });
  const origin = new URL(request.url).origin;
  const { reviewId, hop } = input;
  after(async () => {
    const result = await advanceReview({ admin: createClient(url, key), reviewId });
    if (!result.next) return;
    // A relay chain is bounded: past the last hop the backstops (page return, daily kick) take over, with an alert.
    if (hop + 1 > MAX_HOPS) { logger.error('billing', 'fusion_review_relay_limit', { reviewId, hop }); return; }
    await kickAdvance(origin, reviewId, hop + 1);
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
