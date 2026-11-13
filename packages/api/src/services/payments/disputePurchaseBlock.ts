/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export const DISPUTE_OPEN_PURCHASE_MESSAGE = '你有一笔付款争议（拒付）还没有处理完，处理完之前暂时不能购买。'
  + '如有疑问，请提交工单联系我们。';
export const DISPUTE_LOST_PURCHASE_MESSAGE = '你有一笔付款争议（拒付）已经判定，这个账号暂时不能再购买付费商品。'
  + '如有疑问，请提交工单联系我们。';
/** Distinct type so purchase routers pass this refusal through instead of turning it into a generic 503. */
export class DisputePurchaseBlocked extends TRPCError {}
type Dispute = { provider: string; status: string; closed_at: string | null; freeze_state: string };

/** CHARGEBACK G4 (Owner 2026-11-14): an account with a dispute that is not closed yet, or that was lost, cannot buy
 * anything (subscriptions, credit packs, wallet one-offs). A won dispute does not count. Same account only; no unlock
 * button before launch. Waffo has no outcome feed, so an admin withdrawal of a Waffo hold counts as resolved.
 * Fails closed: if the disputes cannot be read, the purchase is refused as unavailable. */
export function disputeBlock(rows: Dispute[]): 'open' | 'lost' | null {
  if (rows.some(row => row.status === 'lost')) return 'lost';
  const open = rows.some(row => row.closed_at === null && row.freeze_state !== 'external'
    && !(row.provider === 'waffo' && row.freeze_state === 'withdrawn'));
  return open ? 'open' : null;
}

export async function assertNoDisputePurchaseBlock(db: Pick<SupabaseClient, 'from'>, userId: string) {
  const rows = await db.from('payment_disputes').select('provider,status,closed_at,freeze_state,payment_orders!inner(user_id)')
    .eq('payment_orders.user_id', userId).limit(200);
  if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_PURCHASE_CHECK_UNAVAILABLE');
  const block = disputeBlock(rows.data as Dispute[]);
  if (block) {
    throw new DisputePurchaseBlocked({ code: 'FORBIDDEN',
      message: block === 'lost' ? DISPUTE_LOST_PURCHASE_MESSAGE : DISPUTE_OPEN_PURCHASE_MESSAGE });
  }
}
