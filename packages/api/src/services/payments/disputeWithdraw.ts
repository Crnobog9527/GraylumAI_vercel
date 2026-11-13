/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendDisputeWonNotice } from '../notify/reminders';
import { logSwallowed } from '../../lib/swallow';

const withdrawn = z.object({
  restored: z.number().int(), duplicate: z.boolean(), backfilled: z.number().int().optional(),
  userId: z.string().uuid().optional(), orderId: z.string().uuid().optional(), status: z.string().optional(),
});
export type WonEmail = 'sent' | 'not_sent' | 'not_won' | 'failed';
// Only a dispute the bank decided in our favour (or an early warning that closed) gets "resolved, please resubscribe".
const WON = new Set(['won', 'warning_closed']);

/** CHARGEBACK G2: withdraw a dispute hold (the database re-releases paused monthly credits in the same transaction),
 * then email "please resubscribe" for a won membership dispute (Owner 2026-11-14). The email never undoes the
 * withdrawal: a failure is reported to the admin, who can resend it from the payment notices page. */
export async function withdrawDisputeHold(db: SupabaseClient, actor: string, disputeId: string) {
  const result = await db.rpc('pay_dispute_withdraw', { p_actor: actor, p_dispute: disputeId });
  if (result.error || !result.data) throw new Error('PAY_DISPUTE_WITHDRAW_UNAVAILABLE');
  const data = withdrawn.parse(result.data);
  let email: WonEmail = 'not_won';
  if (!data.duplicate && data.userId && data.orderId && WON.has(data.status ?? '')) {
    try {
      const sent = await sendDisputeWonNotice(db, { userId: data.userId, orderId: data.orderId, disputeId },
        { actor });
      // 'skipped' covers orders the notice does not apply to (credit packs, a still-running subscription).
      email = sent.outcome === 'sent' ? 'sent' : 'not_sent';
    } catch (error) {
      logSwallowed('pay_dispute_won_notice_failed', error, { category: 'billing' });
      email = 'failed';
    }
  }
  return { restored: data.restored, duplicate: data.duplicate, backfilled: data.backfilled ?? 0, email };
}
