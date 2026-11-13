/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/** CHARGEBACK G3 (Owner 2026-11-14): one read-only summary per dispute that the Owner copies into the Stripe Dashboard.
 * Nothing is submitted to a provider from here. No IP address or device data exists to include (PAY-EVIDENCE closed
 * 2026-10-19); usage is shown as counts and times only, never conversation content. */
export interface DisputeEvidence {
  dispute: { providerDisputeId: string; provider: string; amount: number | null; currency: string | null; reason: string;
    status: string; openedAt: string; evidenceDueBy: string | null };
  order: { id: string; itemType: string; membershipLevel: string | null; billingCycle: string | null; amountTotal: number | null;
    currency: string | null; paymentMethod: string | null; paidAt: string | null; deliveredAt: string | null;
    entitlementStart: string | null; entitlementEnd: string | null; credits: number | null; termsVersion: string | null;
    termsAcceptedAt: string | null; autoRenew: boolean | null };
  customer: { email: string | null; accountCreatedAt: string | null };
  usage: { spendCount: number; creditsSpent: number; firstUseAt: string | null; lastUseAt: string | null };
}
type Row = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v : null;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

export async function readDisputeEvidence(db: SupabaseClient, disputeId: string): Promise<DisputeEvidence> {
  const dispute = await db.from('payment_disputes').select('provider,provider_dispute_id,amount,currency,reason,status,'
    + 'opened_at,evidence_due_by,order_id').eq('id', disputeId).maybeSingle();
  if (dispute.error) throw new Error('PAY_DISPUTE_EVIDENCE_UNAVAILABLE');
  const d = dispute.data as Row | null;
  if (!d || typeof d.order_id !== 'string') throw new Error('PAY_DISPUTE_EVIDENCE_NO_ORDER');
  const order = await db.from('payment_orders').select('id,user_id,item_type,purchase_membership_level,billing_cycle,amount_total,'
    + 'currency,payment_method,qualified_paid_at,fulfilled_at,entitlement_start,entitlement_end,purchase_snapshot,terms_version,'
    + 'terms_accepted_at,auto_renew').eq('id', d.order_id).maybeSingle();
  const o = order.data as Row | null;
  if (order.error || !o || typeof o.user_id !== 'string') throw new Error('PAY_DISPUTE_EVIDENCE_UNAVAILABLE');
  const paidAt = text(o.qualified_paid_at) ?? text(o.fulfilled_at);
  const [profile, spend] = await Promise.all([
    db.from('profiles').select('email,created_at').eq('id', o.user_id).maybeSingle(),
    db.from('credit_transactions').select('amount,created_at').eq('user_id', o.user_id).eq('ledger_type', 'spend')
      .gte('created_at', paidAt ?? '1970-01-01T00:00:00Z').order('created_at', { ascending: true }).limit(5000),
  ]);
  if (profile.error || spend.error || !Array.isArray(spend.data)) throw new Error('PAY_DISPUTE_EVIDENCE_UNAVAILABLE');
  const uses = spend.data as Row[];
  const snapshot = (o.purchase_snapshot ?? {}) as Row;
  const p = (profile.data ?? {}) as Row;
  return {
    dispute: { providerDisputeId: String(d.provider_dispute_id), provider: String(d.provider), amount: num(d.amount),
      currency: text(d.currency), reason: String(d.reason), status: String(d.status), openedAt: String(d.opened_at),
      evidenceDueBy: text(d.evidence_due_by) },
    order: { id: String(o.id), itemType: String(o.item_type), membershipLevel: text(o.purchase_membership_level),
      billingCycle: text(o.billing_cycle), amountTotal: num(o.amount_total), currency: text(o.currency),
      paymentMethod: text(o.payment_method), paidAt, deliveredAt: text(o.fulfilled_at), entitlementStart: text(o.entitlement_start),
      entitlementEnd: text(o.entitlement_end), credits: num(snapshot.credits), termsVersion: text(o.terms_version),
      termsAcceptedAt: text(o.terms_accepted_at), autoRenew: typeof o.auto_renew === 'boolean' ? o.auto_renew : null },
    customer: { email: text(p.email), accountCreatedAt: text(p.created_at) },
    usage: { spendCount: uses.length, creditsSpent: uses.reduce((sum, row) => sum + Math.abs(num(row.amount) ?? 0), 0),
      firstUseAt: text(uses[0]?.created_at), lastUseAt: text(uses.at(-1)?.created_at) },
  };
}
