/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@supabase/supabase-js';
import { getClientIp } from '../clientIp';
import { createServiceRoleSupabaseClient } from '../stripe';
import { sendPhoneCode, type PhoneSendResult } from './sendCode';
import { handleSmsHook } from './smsHook';
import { authorizeSmsSend } from './smsLimits';
import { smsSenderFor } from './sms/sender';

type Env = Record<string, string | undefined>;

/** One Send SMS hook secret per Supabase project (`v1,whsec_…`), shown by Supabase when the hook is set up. */
export function readHookSecret(env: Env = process.env): string | undefined {
  return env.SEND_SMS_HOOK_SECRET?.trim() || undefined;
}

/** POST /api/auth/sms-hook. Public on purpose: the signature is the authentication; the body is the raw text it covers. */
export async function smsHookResponse(request: Request, env: Env = process.env): Promise<Response> {
  const response = await handleSmsHook(request, {
    secret: readHookSecret(env),
    sender: smsSenderFor(env),
    authorize: key => authorizeSmsSend(createServiceRoleSupabaseClient(), key),
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** POST /api/auth/phone/send: JSON only, so a plain cross-site form cannot post it. */
export async function phoneSendResponse(request: Request, env: Env = process.env): Promise<Response> {
  const json = (result: PhoneSendResult) => Response.json(result.ok ? { ok: true } : { ok: false, code: result.code },
    { status: result.ok ? 200 : result.status, headers: { 'Cache-Control': 'no-store' } });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ ok: false, code: 'PHONE_INVALID', status: 415 });
  }
  const body: unknown = await request.json().catch(() => null);
  const url = env.NEXT_PUBLIC_SUPABASE_URL, anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return json({ ok: false, code: 'SMS_UNAVAILABLE', status: 503 });
  try {
    return json(await sendPhoneCode(body, {
      hookSecret: readHookSecret(env),
      sender: smsSenderFor(env),
      admin: createServiceRoleSupabaseClient(),
      auth: createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }),
      ip: getClientIp(request.headers),
    }));
  } catch {
    return json({ ok: false, code: 'SMS_FAILED', status: 503 });
  }
}
