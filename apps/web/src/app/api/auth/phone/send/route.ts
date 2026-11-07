/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { phoneSendResponse } from '@repo/api/src/services/phoneAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PHONE-OTP: asks Supabase for an SMS code after our per-number and per-IP limits; the browser then calls verifyOtp. */
export async function POST(request: Request) {
  return phoneSendResponse(request);
}
