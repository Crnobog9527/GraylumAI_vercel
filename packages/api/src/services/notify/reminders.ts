/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PAYMENT_NOTICE_TEMPLATES } from './registry';
import { sendPaymentNotice, PaymentNoticeError, type SendNoticeDeps, type NoticeResult } from './sender';
import { enqueuePaymentNotice } from './enqueue';
import { noticeConfig } from './config';

type Db = Pick<SupabaseClient, 'rpc'>;
const ids = z.array(z.string().uuid()).max(500);
export interface ReminderSummary {
  success: boolean;
  scanned: number;
  processed: number;
  sent: number;
  deferred: number;
  held: number;
  attention: Array<Pick<NoticeResult, 'attention'>>;
}

/** Existing 60-second daily cron: leave 10 seconds for the other billing work/response.
 * No automatic processing of dispute-won notices: CHARGEBACK owns their explicit trigger after launch.
 * DB failures are counted/alerted without returning identifiers, addresses or provider messages.
 */
export async function runPaymentReminders(db: Db, deps: Partial<SendNoticeDeps> = {}): Promise<ReminderSummary> {
  const now = deps.now ?? Date.now;
  const deadline = deps.deadline ?? now() + 50_000;
  const summary: ReminderSummary = { success: true, scanned: 0, processed: 0, sent: 0, deferred: 0, held: 0, attention: [] };
  const { data, error } = await db.rpc('payment_notice_scan', { p_limit: 100 });
  if (error) throw new PaymentNoticeError('PAYMENT_NOTICE_SCAN_FAILED');
  const batch = ids.parse(data);
  summary.scanned = batch.length;
  if (!batch.length) return summary;
  const config = deps.config ?? await noticeConfig(db, deps.env);
  for (const id of batch) {
    if (now() + 11_000 > deadline) { summary.deferred += 1; continue; }
    try {
      const result = await sendPaymentNotice(db, id, { ...deps, templates: PAYMENT_NOTICE_TEMPLATES, config, deadline });
      summary.processed += 1;
      if (result.outcome === 'sent') summary.sent += 1;
      if (result.outcome === 'held') summary.held += 1;
      if (result.attention) { summary.attention.push({ attention: result.attention }); summary.success = false; }
    } catch {
      summary.success = false;
      // Fixed code only; the cron emits the Sentry alert and retries the next eligible record.
      summary.attention.push({ attention: 'PAYMENT_NOTICE_SEND_FAILED' });
    }
  }
  return summary;
}

/** Prepared capability only. No webhook/cron invokes this in N2. The future CHARGEBACK caller must
 * first persist a won dispute, remove its freeze, and stop renewal; repeated calls share one key.
 */
export async function sendDisputeWonNotice(db: Db,
  input: { userId: string; orderId: string; disputeId: string }, deps: Partial<SendNoticeDeps> = {}) {
  const ref = z.object({ userId: z.string().uuid(), orderId: z.string().uuid(),
    disputeId: z.string().regex(/^[A-Za-z0-9_:.-]{1,90}$/) }).parse(input);
  const notice = await enqueuePaymentNotice(db, { userId: ref.userId, kind: 'dispute_won_resubscribe',
    sourceRef: ref.orderId, dueKey: ref.disputeId });
  if (!notice.id) return { outcome: 'skipped' as const };
  return sendPaymentNotice(db, notice.id, { ...deps, templates: PAYMENT_NOTICE_TEMPLATES });
}
