/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../../lib/publicError';
import { projectOrderPayment, type PaymentOrderBillingRow } from './orderProjection';
import { normalizePaymentOrderStatus } from '../paymentOrderStatus';

type Documents = { documentStatus?: 'unknown'; invoiceNumber: string | null; invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null; receiptUrl: string | null };
export async function listAdminPaymentOrders(db: Pick<SupabaseClient, 'from'>,
  input: { offset: number; limit: number }, loadDocument: (order: PaymentOrderBillingRow) => Promise<Documents>) {
  const result = await db.from('payment_orders').select([
    'id,user_id,item_id,item_type,billing_cycle,amount_total,currency,status,payment_status,created_at,fulfilled_at',
    'payment_channel,payment_mode,merchant_namespace,price_ref_id,subscription_id,payment_amount_facts,metadata',
  ].join(','), { count: 'exact' }).order('created_at', { ascending: false }).order('id')
    .range(input.offset, input.offset + input.limit - 1);
  if (result.error) throw createSafeServiceUnavailableError(result.error, '订单暂时无法读取，请稍后重试');
  const orders = (result.data ?? []) as unknown as PaymentOrderBillingRow[];
  const items = await Promise.all(orders.map(async order => {
    const documents = await loadDocument(order);
    return { id: order.id, itemType: order.item_type, billingCycle: order.billing_cycle,
      status: normalizePaymentOrderStatus(order.status), paymentStatus: order.payment_status,
      amountMinor: order.amount_total, currency: order.currency,
      createdAt: order.created_at, fulfilledAt: order.fulfilled_at,
      ...projectOrderPayment(order, documents), ...documents };
  }));
  return { items, total: result.count ?? 0 };
}
