/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RenderedNotice } from './templates';

/**
 * Resend HTTPS API (https://resend.com/docs/api-reference/emails/send-email). The notice id is the
 * Idempotency-Key: Resend keeps it 24 hours and never delivers twice for the same key and body
 * (https://resend.com/docs/dashboard/emails/idempotency-keys).
 */
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const NOTICE_REQUEST_TIMEOUT_MS = 10_000;

export interface NoticeMail extends RenderedNotice {
  idempotencyKey: string;
  from: string;
  to: string;
  replyTo: string | null;
}

/**
 * sent: accepted, with the provider id. failed: explicitly refused, nothing was sent (safe to retry
 * later). unknown: 5xx, timeout or a broken connection, it may have been sent (retry only with the same
 * key). conflict: the provider holds a different body under this key (manual review).
 */
export type NoticeTransportResult =
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'failed' | 'unknown' | 'conflict'; code: string };

export type NoticeTransport = (apiKey: string, mail: NoticeMail) => Promise<NoticeTransportResult>;

const PROVIDER_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

async function errorName(response: Response) {
  try {
    const body = await response.json() as { name?: unknown };
    return typeof body?.name === 'string' && /^[a-z_]{1,60}$/.test(body.name) ? body.name : null;
  } catch {
    return null;
  }
}

export function resendTransport(fetchImpl: typeof fetch = fetch, timeoutMs = NOTICE_REQUEST_TIMEOUT_MS): NoticeTransport {
  return async (apiKey, mail) => {
    let response: Response;
    try {
      response = await fetchImpl(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': mail.idempotencyKey,
        },
        body: JSON.stringify({
          from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_UNREACHABLE' };
    }
    if (response.ok) {
      try {
        const body = await response.json() as { id?: unknown };
        if (typeof body?.id === 'string' && PROVIDER_ID.test(body.id)) return { kind: 'sent', providerMessageId: body.id };
      } catch { /* an accepted request without a readable id is still uncertain */ }
      return { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_NO_ID' };
    }
    if (response.status >= 500) return { kind: 'unknown', code: `PAYMENT_NOTICE_PROVIDER_${response.status}` };
    const name = await errorName(response);
    if (response.status === 409) {
      // Another request with this key is still running: same key, may still deliver once.
      if (name === 'concurrent_idempotent_requests') return { kind: 'unknown', code: 'PAYMENT_NOTICE_PROVIDER_IN_FLIGHT' };
      return { kind: 'conflict', code: 'PAYMENT_NOTICE_PROVIDER_IDEMPOTENCY_CONFLICT' };
    }
    return { kind: 'failed', code: `PAYMENT_NOTICE_PROVIDER_${response.status}${name ? `_${name.toUpperCase()}` : ''}` };
  };
}
