/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlatformSecret, PlatformSecretError } from '../platformSecrets/reader';

type Env = Record<string, string | undefined>;

/** N5 (Owner 2026-10-13): sender name and address, to be reconfirmed before launch. */
export const DEFAULT_NOTICE_FROM = 'Graylum AI <no-reply@graylum.com>';
const MAILBOX = /^[^\s@<>,;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export interface NoticeConfig {
  apiKey: string;
  from: string;
  replyTo: string | null;
  /** null: any recipient (the production site). Otherwise only these test addresses. */
  allowedRecipients: ReadonlySet<string> | null;
}

export type NoticeConfigResult =
  | { ok: true; config: NoticeConfig }
  | { ok: false; code: 'PAYMENT_NOTICE_NOT_CONFIGURED' | 'PAYMENT_NOTICE_TEST_RECIPIENTS_MISSING' };

/**
 * Only the approved production project may mail any user: a production deployment of `main` whose
 * production domain is one of ours. Anything else (staging, previews, local runs, a rebound or unknown
 * project) fails closed to the test list in PAYMENT_NOTICE_TEST_RECIPIENTS (PAY-NOTIFY §7 privacy).
 */
const PRODUCTION_URLS: ReadonlySet<string> = new Set(['www.graylum.com', 'app.graylum.com']);
export function isProductionSite(env: Env) {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production' && env.VERCEL_GIT_COMMIT_REF === 'main'
    && PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '');
}

export function normalizeMailbox(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return MAILBOX.test(trimmed) ? trimmed : null;
}

export function testRecipients(env: Env): ReadonlySet<string> {
  const list = (env.PAYMENT_NOTICE_TEST_RECIPIENTS ?? '').split(',')
    .map(item => normalizeMailbox(item)).filter((item): item is string => item !== null);
  return new Set(list);
}

/**
 * The Resend key comes from the admin ("第三方密钥", slot 'resend', no Vercel fallback). Without it
 * nothing is sent and every notice stays pending with a recorded reason.
 * A database failure while reading the key is thrown (PLATFORM_SECRET_UNAVAILABLE), never treated as
 * "not configured".
 */
export async function noticeConfig(admin: Pick<SupabaseClient, 'rpc'>, env: Env = process.env): Promise<NoticeConfigResult> {
  let apiKey: string;
  try {
    apiKey = (await getPlatformSecret(admin, 'resend', { env })).value;
  } catch (error) {
    if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') {
      return { ok: false, code: 'PAYMENT_NOTICE_NOT_CONFIGURED' };
    }
    throw error;
  }
  const allowedRecipients = isProductionSite(env) ? null : testRecipients(env);
  if (allowedRecipients && allowedRecipients.size === 0) return { ok: false, code: 'PAYMENT_NOTICE_TEST_RECIPIENTS_MISSING' };
  return { ok: true, config: {
    apiKey,
    from: env.PAYMENT_NOTICE_FROM?.trim() || DEFAULT_NOTICE_FROM,
    replyTo: normalizeMailbox(env.PAYMENT_NOTICE_REPLY_TO) ?? 'support@graylum.com',
    allowedRecipients,
  } };
}
