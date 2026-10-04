/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeScope } from './purchaseFacts';
import { findStripeReference } from './stripeReferences';

// Only structural references and a fixed reason are retained. A compare-and-swap preserves
// financial metadata written concurrently; the database additionally enforces append-only history.
export async function recordStripeInvoiceConflict(input: {
  db: Pick<SupabaseClient, 'from'>;
  scope: StripeScope;
  invoiceId: string;
  sourceOrderId?: string | null;
}) {
  if (!/^in_[A-Za-z0-9_]+$/.test(input.invoiceId)) return;
  const mapped = await findStripeReference(input.db, 'invoice', input.invoiceId, input.scope);
  const id = mapped?.order_id ?? input.sourceOrderId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const fact = { evidence_ref: input.invoiceId, reason: 'PAY_COMMON_INVOICE_EVIDENCE_REJECTED' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await input.db.from('payment_orders').select('id,metadata')
      .eq('id', id).eq('payment_channel', 'stripe').eq('merchant_namespace', input.scope.merchant)
      .eq('payment_mode', input.scope.mode).maybeSingle();
    if (result.error) throw new Error('PAY_COMMON_CONFLICT_WRITE_FAILED');
    if (!result.data) return;
    const metadata = result.data.metadata ?? {};
    const conflicts = metadata.paymentConflicts ?? [];
    if (!Array.isArray(conflicts)) throw new Error('PAY_COMMON_CONFLICT_WRITE_FAILED');
    if (conflicts.some(row => row?.evidence_ref === fact.evidence_ref && row?.reason === fact.reason)) return;
    if (conflicts.length >= 32) throw new Error('PAY_COMMON_CONFLICT_LIMIT');
    const updated = await input.db.from('payment_orders')
      .update({ metadata: { ...metadata, paymentConflicts: [...conflicts, fact] } })
      .eq('id', id).eq('metadata', JSON.stringify(metadata)).select('id');
    if (updated.error) throw new Error('PAY_COMMON_CONFLICT_WRITE_FAILED');
    if (updated.data?.length === 1) return;
  }
  throw new Error('PAY_COMMON_CONFLICT_WRITE_RETRY_REQUIRED');
}
