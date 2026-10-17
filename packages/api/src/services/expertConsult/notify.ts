/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { normalizeMailbox, noticeConfig, type NoticeConfigResult } from '../notify/config';
import { resendTransport, type NoticeTransport } from '../notify/resend';
import { noticeLayout } from '../notify/templates';

/** Keeps the booking request fast: one short attempt, the ticket is the durable record anyway. */
export const OWNER_NOTICE_TIMEOUT_MS = 5_000;

export interface OwnerNoticeDeps {
  config?: NoticeConfigResult;
  transport?: NoticeTransport;
  env?: Record<string, string | undefined>;
}

/** The mail carries the ticket id only; the need and contact details stay in the ticket. */
export function ownerNotice(ticketId: string) {
  return noticeLayout('新的专家诊断预约 / New expert consultation request', [
    '有一条新的专家诊断预约，请到后台“工单”查看（分类：专家诊断预约）。',
    `工单号 / Ticket: ${ticketId}`,
    'A new expert consultation request is waiting in the admin ticket list (category 专家诊断预约).',
  ]);
}

async function supportMailbox(db: Pick<SupabaseClient, 'from'>) {
  const { data, error } = await db.from('system_settings').select('value').eq('key', 'support_email').maybeSingle();
  if (error) return null;
  const value = (data as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? normalizeMailbox(value) : null;
}

/**
 * Tells the Owner a new request arrived (Master Plan 2.1 item 51: "提交后通知 Owner"). Sent with PAY-NOTIFY's
 * Resend key and sender (#1031) to the support mailbox in system settings. Outside production only the
 * PAYMENT_NOTICE_TEST_RECIPIENTS addresses are mailed (same guard as payment notices). Every request also
 * leaves a persisted warn log. Without a key, a mailbox or a working provider nothing is sent and the
 * outcome is logged; it never throws. The Resend idempotency key is the ticket id, so a retry never
 * mails twice.
 */
export async function notifyOwnerOfExpertConsult(db: Pick<SupabaseClient, 'rpc' | 'from'>, ticketId: string,
  deps: OwnerNoticeDeps = {}): Promise<string> {
  logger.warn('api', 'expert_consult_requested', { ticketId });
  let outcome: string;
  try {
    const config = deps.config ?? await noticeConfig(db, deps.env);
    const to = await supportMailbox(db);
    if (!config.ok) outcome = config.code;
    else if (!to) outcome = 'EXPERT_CONSULT_NOTICE_NO_MAILBOX';
    else if (config.config.allowedRecipients && !config.config.allowedRecipients.has(to)) {
      outcome = 'EXPERT_CONSULT_NOTICE_RECIPIENT_NOT_ALLOWED';
    } else {
      const transport = deps.transport ?? resendTransport(fetch, OWNER_NOTICE_TIMEOUT_MS);
      const result = await transport(config.config.apiKey, {
        ...ownerNotice(ticketId), idempotencyKey: `expert-consult-${ticketId}`,
        from: config.config.from, to, replyTo: config.config.replyTo,
      });
      outcome = result.kind === 'sent' ? 'sent' : result.code;
    }
  } catch {
    outcome = 'EXPERT_CONSULT_NOTICE_UNAVAILABLE';
  }
  if (outcome === 'sent') logger.info('api', 'expert_consult_notice_sent', { ticketId });
  else logger.warn('api', 'expert_consult_notice_not_sent', { ticketId, code: outcome });
  return outcome;
}
