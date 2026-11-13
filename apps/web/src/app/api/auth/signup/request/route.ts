/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { signupRequestResponse } from '@repo/api/src/services/signupGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * BOT-GUARD: registers an email sign-up (hashed address + IP, limited per IP in the database) right before the browser
 * calls supabase.auth.signUp; Supabase's Before User Created hook refuses email sign-ups that skipped this step.
 */
export async function POST(request: Request) {
  return signupRequestResponse(request);
}
