/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WaffoOperationsClient } from './waffoTestOperationsClient';
import { reconcileWaffoRefund } from './waffoRefund';

/** Reconcile the original provider after a channel switch; never approves or sends new refunds. */
export async function reconcileFailoverRefunds(db: SupabaseClient, provider: WaffoOperationsClient, deadline = Date.now() + 45_000) {
  const findings: Array<{ kind: string; orderId?: string }> = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    if (Date.now() >= deadline) break;
    let query = db.from('payment_orders').select('id').eq('payment_channel', 'waffo')
      .eq('merchant_namespace', provider.merchant).eq('payment_mode', provider.mode)
      .in('refund_approval->>status', ['dispatching', 'pending', 'review_required']);
    if (after) query = query.gt('id', after);
    const result = await query.order('id').limit(100);
    if (result.error || !Array.isArray(result.data)) throw new Error('PAY_REFUND_LOOKUP_INCOMPLETE');
    for (const row of result.data) {
      if (Date.now() >= deadline) {
        findings.push({ kind: 'refund_scan_incomplete' });
        return { success: false, findings };
      }
      try {
        const observed = await reconcileWaffoRefund(db, provider, undefined, row.id);
        if (observed.status !== 'succeeded' && observed.status !== 'failed') {
          findings.push({ kind: 'refund_unresolved', orderId: row.id });
        }
      } catch { findings.push({ kind: 'refund_lookup_failed', orderId: row.id }); }
    }
    if (result.data.length < 100) return { success: findings.length === 0, findings };
    after = result.data.at(-1)!.id;
  }
  findings.push({ kind: 'refund_scan_incomplete' });
  return { success: false, findings };
}
