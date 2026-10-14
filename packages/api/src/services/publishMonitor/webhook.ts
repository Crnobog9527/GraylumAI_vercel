/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';

/**
 * Post for Me webhook (plan §4.1). The provider authenticates with a shared secret in a header (not a signature),
 * waits about one second and retries up to 8 times, and sends no event id. So handling is fast and idempotent:
 * only a provider-side disconnect changes anything here; everything else is settled by the daily job, which reads
 * the provider directly (the webhook only speeds things up).
 */
export const WEBHOOK_SECRET_HEADER = 'post-for-me-webhook-secret';
const MAX_BODY_BYTES = 64 * 1024;
// The provider waits about one second; the write gets most of it and is retried by the provider if it runs out.
const WRITE_TIMEOUT_MS = 700;
type Rpc = Pick<SupabaseClient, 'rpc'>;

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
/** Constant-time comparison of equal-length digests, so neither content nor length leaks through timing. */
export function secretMatches(given: string | null, expected: string): boolean {
  return given !== null && timingSafeEqual(digest(given), digest(expected));
}

const event = z.object({ event_type: z.string().max(64), data: z.unknown() }).passthrough();
const accountData = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), status: z.string().max(32) }).passthrough();

export type WebhookResult = { status: number; body: { ok: boolean; error?: string } };

export async function handlePostForMeWebhook(request: Request, secret: string | undefined, db: () => Rpc):
  Promise<WebhookResult> {
  if (!secret || secret.trim().length < 16) return { status: 503, body: { ok: false, error: 'NOT_CONFIGURED' } };
  if (!secretMatches(request.headers.get(WEBHOOK_SECRET_HEADER), secret.trim())) {
    return { status: 401, body: { ok: false, error: 'UNAUTHORIZED' } };
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: 'TOO_LARGE' } };
  let parsed: z.infer<typeof event>;
  try {
    const result = event.safeParse(JSON.parse(raw));
    if (!result.success) return { status: 400, body: { ok: false, error: 'INVALID' } };
    parsed = result.data;
  } catch {
    return { status: 400, body: { ok: false, error: 'INVALID' } };
  }
  if (parsed.event_type === 'social.account.updated') {
    const account = accountData.safeParse(parsed.data);
    if (!account.success) return { status: 400, body: { ok: false, error: 'INVALID' } };
    if (account.data.status === 'disconnected') {
      const result = await db().rpc('publish_monitor_provider_account_disconnected', {
        p_provider_account_id: account.data.id }).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))
        .then(r => r, () => ({ error: { message: 'TIMEOUT' } }));
      // A failed or slow write is retried by the provider (the update is idempotent); answer within its deadline.
      if (result.error) return { status: 503, body: { ok: false, error: 'UNAVAILABLE' } };
    }
    return { status: 200, body: { ok: true } };
  }
  // social.account.created and others: nothing to do synchronously; the daily cleanup and sweep settle them.
  logger.info('api', 'publish_monitor_webhook_ignored', { eventType: parsed.event_type });
  return { status: 200, body: { ok: true } };
}
