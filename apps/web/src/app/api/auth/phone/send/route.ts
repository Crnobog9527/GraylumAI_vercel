/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { phoneSendResponse } from '@repo/api/src/services/phoneAuth';
import { checkRateLimit, getClientIP } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const answer = (code: 'RATE_LIMITED' | 'SMS_UNAVAILABLE', status: number, retryAfter: number) => Response.json(
  { ok: false, code }, { status, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) } });

/**
 * PHONE-OTP: asks Supabase for an SMS code after our per-number and per-IP limits; the browser then calls verifyOtp.
 * First every attempt from the IP is counted (deep review 11-11 item 7), whatever happens next: a request Supabase refuses
 * gives back the per-number row in the database but not this count. One IP therefore cannot keep a stranger's number
 * in its 60-second cooldown, and the per-number limits stay as they are.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimit(getClientIP(request), 'phone_send');
  if (limit.reason === 'unavailable') return answer('SMS_UNAVAILABLE', 503, 60);
  if (!limit.success) return answer('RATE_LIMITED', 429, limit.retryAfter ?? 60);
  return phoneSendResponse(request);
}
