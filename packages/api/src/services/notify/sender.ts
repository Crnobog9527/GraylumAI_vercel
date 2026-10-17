/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { noticeConfig, normalizeMailbox, type NoticeConfigResult } from './config';
import { resendTransport, type NoticeTransport, type NoticeTransportResult } from './resend';
import {
  noticeDigest, PAYMENT_NOTICE_KINDS, PAYMENT_NOTICE_LOCALE, type PaymentNoticeTemplates,
} from './templates';

type Rpc = Pick<SupabaseClient, 'rpc'>;

/** Same-run retries for an uncertain result (PAY-NOTIFY §4.3): wait 5 s, then 15 s, if time allows. */
export const UNKNOWN_RETRY_DELAYS_MS = [5_000, 15_000] as const;
const RETRY_REQUEST_BUDGET_MS = 11_000;
export const MAX_NOTICE_ATTEMPTS = 3;

export type NoticeOutcome =
  | 'sent' | 'failed' | 'unknown' | 'manual' | 'skipped' | 'held' | 'busy' | 'done' | 'refused';

export interface NoticeResult {
  outcome: NoticeOutcome;
  code?: string;
  /** Set when a person has to look (Sentry at the cron boundary, the admin list otherwise). */
  attention?: 'PAYMENT_NOTICE_RETRIES_EXHAUSTED' | 'PAYMENT_NOTICE_UNKNOWN_UNRESOLVED'
    | 'PAYMENT_NOTICE_DIGEST_MISMATCH' | 'PAYMENT_NOTICE_TEMPLATE_MISSING' | 'PAYMENT_NOTICE_UNKNOWN_EXPIRED';
}

export interface SendNoticeDeps {
  templates: PaymentNoticeTemplates;
  config?: NoticeConfigResult;
  env?: Record<string, string | undefined>;
  transport?: NoticeTransport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Absolute time (ms) by which this call must return; same-run retries only start if they fit. */
  deadline?: number;
  /** Set for the admin "resend with the same idempotency key" button. */
  actor?: string;
}

const prepared = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(PAYMENT_NOTICE_KINDS),
  templateParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  state: z.string(),
  attempts: z.number().int(),
  email: z.string().nullable(),
  erasing: z.boolean(),
});
const claimed = z.object({
  decision: z.enum(['send', 'busy', 'skip', 'manual', 'done', 'refused']),
  attempt: z.number().int().optional(),
  reason: z.string().optional(),
});

export class PaymentNoticeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PaymentNoticeError'; }
}

async function rpc<T>(db: Rpc, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    logger.error('billing', 'payment_notice_rpc_failed', { fn, code: error.code ?? 'unknown' });
    throw new PaymentNoticeError(error.code === '42501' ? 'PAYMENT_NOTICE_ACTOR_DENIED' : 'PAYMENT_NOTICE_UNAVAILABLE');
  }
  return schema.parse(data);
}

const hold = (db: Rpc, id: string, state: 'pending' | 'skipped', code: string) =>
  rpc(db, 'payment_notice_hold', { p_id: id, p_state: state, p_code: code }, z.object({ held: z.boolean() }).passthrough());
const finish = (db: Rpc, id: string, attempt: number, outcome: 'sent' | 'failed' | 'unknown' | 'unresolved',
  providerMessageId: string | null, code: string | null) =>
  rpc(db, 'payment_notice_finish', { p_id: id, p_attempt: attempt, p_outcome: outcome,
    p_provider_message_id: providerMessageId, p_error_code: code },
  z.object({ state: z.string(), attempts: z.number().int().optional() }).passthrough());

/**
 * Sends one recorded notice at most once. Order: re-read the row and the live address, check the
 * configuration and the recipient, render, fix the digest, claim, call the provider with the row id as
 * idempotency key, record the result. Only codes are logged: no address, no body, no key.
 */
export async function sendPaymentNotice(db: Rpc, noticeId: string, deps: SendNoticeDeps): Promise<NoticeResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const actor = deps.actor ?? null;
  const { data: raw, error } = await db.rpc('payment_notice_prepare', { p_id: noticeId });
  if (error) throw new PaymentNoticeError('PAYMENT_NOTICE_UNAVAILABLE');
  if (raw === null) return { outcome: 'done' };
  const notice = prepared.parse(raw);
  if (notice.erasing) {
    await hold(db, notice.id, 'skipped', 'PAYMENT_NOTICE_ACCOUNT_ERASURE');
    return { outcome: 'skipped', code: 'PAYMENT_NOTICE_ACCOUNT_ERASURE' };
  }
  const configResult = deps.config ?? await noticeConfig(db, deps.env);
  if (!configResult.ok) {
    if (actor) throw new PaymentNoticeError(configResult.code);
    // Not configured yet: nothing is sent, the row stays pending with the reason recorded.
    await hold(db, notice.id, 'pending', configResult.code);
    return { outcome: 'held', code: configResult.code };
  }
  const { config } = configResult;
  const to = normalizeMailbox(notice.email);
  if (!to || config.allowedRecipients && !config.allowedRecipients.has(to)) {
    // Staging only mails the test list; a real user's address is never contacted there.
    const code = to ? 'PAYMENT_NOTICE_RECIPIENT_NOT_ALLOWED' : 'PAYMENT_NOTICE_NO_RECIPIENT';
    if (actor) throw new PaymentNoticeError(code);
    await hold(db, notice.id, 'skipped', code);
    return { outcome: 'skipped', code };
  }
  const template = deps.templates[notice.kind];
  if (!template) {
    if (actor) throw new PaymentNoticeError('PAYMENT_NOTICE_TEMPLATE_MISSING');
    await hold(db, notice.id, 'pending', 'PAYMENT_NOTICE_TEMPLATE_MISSING');
    return { outcome: 'held', code: 'PAYMENT_NOTICE_TEMPLATE_MISSING', attention: 'PAYMENT_NOTICE_TEMPLATE_MISSING' };
  }
  const rendered = template.render(notice.templateParams);
  const digest = noticeDigest({ to, locale: PAYMENT_NOTICE_LOCALE, version: template.version, rendered });
  const transport = deps.transport ?? resendTransport();
  const mail = { ...rendered, idempotencyKey: notice.id, from: config.from, to, replyTo: config.replyTo };

  const claim = () => rpc(db, 'payment_notice_claim',
    { p_id: notice.id, p_digest: digest, p_template_version: template.version, p_actor: actor }, claimed);
  let decision = await claim();
  let retries = 0;
  for (;;) {
    if (decision.decision !== 'send' || decision.attempt === undefined) break;
    const attempt = decision.attempt;
    const last: NoticeTransportResult = await transport(config.apiKey, mail);
    if (last.kind === 'sent') {
      await finish(db, notice.id, attempt, 'sent', last.providerMessageId, null);
      logger.info('billing', 'payment_notice_sent', { kind: notice.kind, attempt });
      return { outcome: 'sent' };
    }
    if (last.kind === 'failed') {
      const row = await finish(db, notice.id, attempt, 'failed', null, last.code);
      logger.warn('billing', 'payment_notice_failed', { kind: notice.kind, attempt, code: last.code });
      return { outcome: 'failed', code: last.code,
        ...((row.attempts ?? attempt) >= MAX_NOTICE_ATTEMPTS ? { attention: 'PAYMENT_NOTICE_RETRIES_EXHAUSTED' as const } : {}) };
    }
    const delay = UNKNOWN_RETRY_DELAYS_MS[retries];
    const fits = delay !== undefined && !actor && last.kind === 'unknown'
      && (deps.deadline === undefined || now() + delay + RETRY_REQUEST_BUDGET_MS <= deps.deadline);
    if (!fits) {
      // Still uncertain: manual review now, with the admin button (same key) for 24 hours.
      await finish(db, notice.id, attempt, 'unresolved', null, last.code);
      logger.warn('billing', 'payment_notice_unresolved', { kind: notice.kind, attempt, code: last.code });
      return { outcome: 'manual', code: last.code, attention: 'PAYMENT_NOTICE_UNKNOWN_UNRESOLVED' };
    }
    await finish(db, notice.id, attempt, 'unknown', null, last.code);
    retries += 1;
    await sleep(delay);
    decision = await claim();
  }
  switch (decision.decision) {
  case 'manual':
    return { outcome: 'manual', code: decision.reason,
      attention: decision.reason === 'digest_mismatch' ? 'PAYMENT_NOTICE_DIGEST_MISMATCH' : 'PAYMENT_NOTICE_UNKNOWN_EXPIRED' };
  case 'skip': return { outcome: 'skipped', code: 'PAYMENT_NOTICE_ACCOUNT_ERASURE' };
  case 'busy': return { outcome: 'busy' };
  case 'refused': return { outcome: 'refused' };
  default: return { outcome: 'done' };
  }
}
