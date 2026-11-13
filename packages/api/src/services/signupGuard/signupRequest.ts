/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { swallow } from '../../lib/swallow';
import { getClientIp } from '../clientIp';
import { createServiceRoleSupabaseClient } from '../stripe';

/**
 * POST /api/auth/signup/request (BOT-GUARD). The login page runs in the browser, so this is the server step before
 * supabase.auth.signUp: it records the sha256 of the normalised email and the visitor's IP (signup_request, 5 per IP
 * per hour, 20 per day). The Supabase "Before User Created" hook (hook_before_user_created) refuses an email sign-up
 * without such a record from the last 10 minutes, so calling the Auth API directly creates no account.
 * The address itself is never stored or logged.
 */
export const signupRequestInput = z.object({ email: z.string().trim().min(3).max(320).email() }).strict();

export type SignupRequestCode = 'EMAIL_INVALID' | 'SIGNUP_TOO_MANY_HOURLY' | 'SIGNUP_TOO_MANY_DAILY' | 'SIGNUP_UNAVAILABLE';
export type SignupRequestResult = { ok: true } | { ok: false; code: SignupRequestCode; status: number };

/** Same normalisation as the hook (btrim + lower): the key the hook recomputes from the Auth user's email. */
export function signupEmailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

const statusSchema = z.enum(['ok', 'ip_hourly', 'ip_daily']);

export async function requestSignup(raw: unknown, deps: { admin: Pick<SupabaseClient, 'rpc'>; ip: string | null }):
  Promise<SignupRequestResult> {
  const parsed = signupRequestInput.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'EMAIL_INVALID', status: 400 };
  const ip = deps.ip && isIP(deps.ip) ? deps.ip : null;
  const { data, error } = await deps.admin.rpc('signup_request', { p_email_key: signupEmailKey(parsed.data.email), p_ip: ip });
  const status = statusSchema.safeParse(data);
  if (error || !status.success) {
    logger.error('auth', 'signup_request_failed', { code: error?.code ?? null });
    return { ok: false, code: 'SIGNUP_UNAVAILABLE', status: 503 };
  }
  if (status.data === 'ok') return { ok: true };
  logger.warn('auth', 'signup_request_limited', { limit: status.data });
  return { ok: false, code: status.data === 'ip_hourly' ? 'SIGNUP_TOO_MANY_HOURLY' : 'SIGNUP_TOO_MANY_DAILY', status: 429 };
}

/** The route: JSON only, so a plain cross-site form cannot post it. */
export async function signupRequestResponse(request: Request,
  admin: () => Pick<SupabaseClient, 'rpc'> = createServiceRoleSupabaseClient): Promise<Response> {
  const json = (result: SignupRequestResult) => Response.json(result.ok ? { ok: true } : { ok: false, code: result.code },
    { status: result.ok ? 200 : result.status, headers: { 'Cache-Control': 'no-store' } });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ ok: false, code: 'EMAIL_INVALID', status: 415 });
  }
  const body: unknown = await swallow('signup_request_body_unreadable', request.json(), null, { category: 'auth' });
  try {
    return json(await requestSignup(body, { admin: admin(), ip: getClientIp(request.headers) }));
  } catch {
    return json({ ok: false, code: 'SIGNUP_UNAVAILABLE', status: 503 });
  }
}
