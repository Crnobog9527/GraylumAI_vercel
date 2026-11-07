/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * The two steps of a code against public.sms_sends (migration "sms_sends"), service-role client only.
 * Limits over the last 24 hours: 1 per number per 60 s, 5 per number, 20 per IP.
 */
const statusSchema = z.enum(['ok', 'phone_cooldown', 'phone_daily', 'ip_daily', 'no_request']);
export type SmsLimitStatus = z.infer<typeof statusSchema>;

type Rpc = Pick<SupabaseClient, 'rpc'>;

export class SmsLimitError extends Error {
  constructor(readonly fn: string) { super(`${fn} failed`); this.name = 'SmsLimitError'; }
}

async function call(db: Rpc, fn: string, args: Record<string, unknown>): Promise<SmsLimitStatus> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new SmsLimitError(fn);
  return statusSchema.parse(data);
}

/** The send route, before signInWithOtp. `ip` is the visitor's (null when no proxy header). */
export function requestSmsSend(db: Rpc, key: string, ip: string | null): Promise<SmsLimitStatus> {
  return call(db, 'sms_request_send', { p_phone_key: key, p_ip: ip });
}

/** The Send SMS hook, before any provider is called. */
export function authorizeSmsSend(db: Rpc, key: string): Promise<SmsLimitStatus> {
  return call(db, 'sms_authorize_send', { p_phone_key: key });
}

/** Supabase refused before the hook ran (failed hCaptcha, its own limit): the request no longer counts. */
export async function releaseSmsSend(db: Rpc, key: string): Promise<void> {
  const { error } = await db.rpc('sms_release_send', { p_phone_key: key });
  if (error) throw new SmsLimitError('sms_release_send');
}
