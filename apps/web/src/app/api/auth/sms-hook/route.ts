/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { smsHookResponse } from '@repo/api/src/services/phoneAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Supabase Auth "Send SMS" hook (PHONE-OTP). Supabase calls it without a session; the Standard Webhooks signature
 * is checked first. The body carries the code, so nothing here logs the request.
 */
export async function POST(request: Request) {
  return smsHookResponse(request);
}
