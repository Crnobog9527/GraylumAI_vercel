/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export type PreviewDb = Pick<SupabaseClient, 'from'>;
const ref = z.string().min(1);
const nullable = ref.nullable();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const orderSchema = z.object({
  id: ref, user_id: ref, item_type: ref, item_id: ref, billing_cycle: ref,
  status: ref, payment_status: nullable, amount_total: integer.nullable(), currency: ref,
  payment_channel: nullable, payment_mode: nullable, merchant_namespace: nullable,
  purchase_snapshot: z.unknown(), subscription_id: nullable, source_order_id: nullable,
  fulfilled_at: nullable, updated_at: ref, refund_status: z.string().nullable(),
});
export type PreviewOrder = z.infer<typeof orderSchema>;
const columns = {
  orders: 'id,user_id,item_type,item_id,billing_cycle,status,payment_status,amount_total,currency,'
    + 'payment_channel,payment_mode,merchant_namespace,purchase_snapshot,subscription_id,source_order_id,'
    + 'fulfilled_at,updated_at,refund_status:refund_approval->>status',
  profiles: 'id,role,status,is_deleted',
  tickets: 'id,user_id,category,is_deleted,created_at,updated_at',
  subscriptions: 'id,user_id,status,payment_channel,payment_mode,merchant_namespace,contract_snapshot,updated_at',
  grants: 'id,user_id,subscription_id,source_order_id,grant_snapshot,status,credits_granted,credit_transaction_id,updated_at',
  ledger: 'id,user_id,created_at,amount,type,ledger_type,reason_code,source_type,idempotency_key,source_order_id,counts_as_spend',
  holds: 'id,user_id,operation_type,pre_deduct_id:metadata->>preDeductId',
  refs: 'id,order_id,subscription_id,channel,mode,merchant_namespace,object_type,external_id',
};
const profileSchema = z.object({ id: ref, role: ref, status: ref, is_deleted: z.string() });
const ticketSchema = z.object({
  id: ref, user_id: ref, category: ref, is_deleted: z.string(), created_at: ref, updated_at: ref,
});
const subscriptionSchema = z.object({
  id: ref, user_id: ref, status: ref, payment_channel: nullable, payment_mode: nullable,
  merchant_namespace: nullable, contract_snapshot: z.unknown(), updated_at: ref,
});
const grantSchema = z.object({
  id: ref, user_id: ref, subscription_id: nullable, source_order_id: nullable, grant_snapshot: z.unknown(),
  status: ref, credits_granted: integer, credit_transaction_id: nullable, updated_at: ref,
});
const ledgerSchema = z.object({
  id: ref, user_id: ref, created_at: ref, amount: z.union([z.number().finite(), z.string()]),
  type: ref, ledger_type: nullable, reason_code: nullable, source_type: nullable, idempotency_key: nullable,
  source_order_id: nullable, counts_as_spend: z.boolean().nullable(),
});
const holdSchema = z.object({ id: ref, user_id: ref, operation_type: ref, pre_deduct_id: nullable });
const mappingSchema = z.object({
  id: ref, order_id: nullable, subscription_id: nullable, channel: ref, mode: ref,
  merchant_namespace: ref, object_type: ref, external_id: ref,
});
type Filter = { column: string; value: string | string[] };

// Exact count + a stable unique order detects truncated/duplicated pages. The cap
// is an evidence limit, never permission to treat the prefix as complete history.
async function readRows<T extends z.ZodType>(
  db: PreviewDb, table: string, select: string, schema: T, filters: Filter[],
): Promise<z.infer<T>[]> {
  const rows: unknown[] = [];
  let total: number | undefined;
  const ids = new Set<string>();
  for (let offset = 0; offset < 2000; offset += 100) {
    let query = db.from(table).select(select, { count: 'exact' });
    for (const { column, value } of filters) {
      query = Array.isArray(value) ? query.in(column, value) : query.eq(column, value);
    }
    const result = await query.order('id', { ascending: true }).range(offset, offset + 99);
    if (result.error || !Array.isArray(result.data) || result.count === null
      || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > 2000
      || (total !== undefined && result.count !== total)) throw new Error('PAY_REFUND_HISTORY_INCOMPLETE');
    total = result.count;
    if (result.data.length !== Math.min(100, total - offset)) throw new Error('PAY_REFUND_HISTORY_INCOMPLETE');
    for (const row of result.data) {
      const parsed = schema.parse(row);
      const id = (parsed as { id: string }).id;
      if (ids.has(id)) throw new Error('PAY_REFUND_HISTORY_INCOMPLETE');
      ids.add(id);
      rows.push(parsed);
    }
    if (rows.length === total) return rows as z.infer<T>[];
  }
  throw new Error('PAY_REFUND_HISTORY_INCOMPLETE');
}
const equal = (column: string, value: string | string[]): Filter => ({ column, value });
export async function readPreviewOrder(db: PreviewDb, id: string) {
  const rows = await readRows(db, 'payment_orders', columns.orders, orderSchema, [equal('id', id)]);
  if (rows.length !== 1) throw new Error('PAY_REFUND_ORDER_UNKNOWN');
  return rows[0];
}
export async function readSubscriptionRefundEvidence(db: PreviewDb, actorId: string, order: PreviewOrder, ticketId: string) {
  const actors = await readRows(db, 'profiles', columns.profiles, profileSchema, [equal('id', actorId)]);
  const actor = actors[0];
  if (actors.length !== 1 || actor.role !== 'admin' || actor.status !== 'active' || actor.is_deleted !== 'false') {
    throw new Error('PAY_REFUND_ADMIN_REQUIRED');
  }
  const subjects = await readRows(db, 'profiles', columns.profiles, profileSchema, [equal('id', order.user_id)]);
  if (subjects.length !== 1 || subjects[0].status !== 'active' || subjects[0].is_deleted !== 'false') {
    throw new Error('PAY_REFUND_SUBJECT_UNAVAILABLE');
  }
  const tickets = await readRows(db, 'tickets', columns.tickets, ticketSchema, [equal('id', ticketId)]);
  if (tickets.length !== 1 || tickets[0].user_id !== order.user_id || tickets[0].category !== 'billing'
    || tickets[0].is_deleted !== 'false') throw new Error('PAY_REFUND_TICKET_MISMATCH');
  const user = [equal('user_id', order.user_id)];
  // Include ended/refunded orders and subscriptions, not just the current entitlement.
  const orders = await readRows(db, 'payment_orders', columns.orders, orderSchema,
    [...user, equal('item_type', 'membership_plan')]);
  const subscriptions = await readRows(db, 'user_subscriptions', columns.subscriptions, subscriptionSchema, user);
  const grants = await readRows(db, 'subscription_credit_grants', columns.grants, grantSchema, user);
  const ledger = await readRows(db, 'credit_transactions', columns.ledger, ledgerSchema, user);
  const holds = await readRows(db, 'billing_history', columns.holds, holdSchema, user);
  const orderRefs = orders.length ? await readRows(db, 'payment_provider_refs', columns.refs, mappingSchema,
    [equal('order_id', orders.map(row => row.id))]) : [];
  const subscriptionRefs = subscriptions.length ? await readRows(db, 'payment_provider_refs', columns.refs, mappingSchema,
    [equal('subscription_id', subscriptions.map(row => row.id))]) : [];
  return { actor, subject: subjects[0], ticket: tickets[0], orders, subscriptions, grants, ledger, holds,
    refs: [...orderRefs, ...subscriptionRefs] };
}
export type SubscriptionRefundEvidence = Awaited<ReturnType<typeof readSubscriptionRefundEvidence>>;
