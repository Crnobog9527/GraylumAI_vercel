/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Rows the daily readiness audit (billingReconciliation.ts) reads, and the paged table scan that reads them.
import type { SupabaseClient } from '@supabase/supabase-js';

export type ProfileRow = {
  id?: string | null;
  credits?: number | string | null;
  created_at?: string | null;
};

export type CreditTransactionRow = {
  id?: string | null;
  user_id?: string | null;
  amount?: number | string | null;
  type?: string | null;
  ledger_type?: string | null;
  reason_code?: string | null;
  counts_as_spend?: boolean | null;
  source_type?: string | null;
  source_order_id?: string | null;
  grant_period_key?: string | null;
  idempotency_key?: string | null;
  balance_before?: number | string | null;
  balance_after?: number | string | null;
  metadata?: unknown;
  created_at?: string | null;
};

export type PaymentOrderRow = {
  id?: string | null;
  user_id?: string | null;
  item_type?: string | null;
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  amount_total?: number | string | null;
  fulfilled_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  stripe_subscription_id?: string | null;
  stripe_invoice_id?: string | null;
  metadata?: unknown;
  /** Current model (PAY-STRIPE-MP / PAY-FAILOVER): the internal subscription and an approved refund's record. */
  subscription_id?: string | null;
  refund_approval?: unknown;
};

export type SubscriptionCreditGrantRow = {
  id?: string | null;
  user_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_invoice_id?: string | null;
  billing_cycle?: string | null;
  grant_type?: string | null;
  grant_period_key?: string | null;
  period_index?: number | string | null;
  total_periods?: number | string | null;
  credits_granted?: number | string | null;
  consumed_amount?: number | string | null;
  accounting_state?: string | null;
  status?: string | null;
  idempotency_key?: string | null;
  credit_transaction_id?: string | null;
  metadata?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type SubscriptionRow = {
  id?: string | null;
  user_id?: string | null;
  membership_plan_id?: string | null;
  stripe_subscription_id?: string | null;
  status?: string | null;
  cancel_at_period_end?: string | boolean | null;
  billing_cycle?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  credit_release_terminated_at?: string | null;
  credit_release_terminated_reason?: string | null;
  credit_release_terminated_event_id?: string | null;
  credit_release_terminated_period_key?: string | null;
  metadata?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type MembershipPlanRow = {
  id?: string | null;
  yearly_credits?: number | string | null;
};

export type BillingHistoryRow = {
  id?: string | null;
  user_id?: string | null;
  operation_type?: string | null;
  amount?: number | string | null;
  metadata?: unknown;
  created_at?: string | null;
};

export type BillingReadinessRows = {
  billingHistory?: BillingHistoryRow[];
  profiles: ProfileRow[];
  creditTransactions: CreditTransactionRow[];
  paymentOrders: PaymentOrderRow[];
  subscriptionCreditGrants: SubscriptionCreditGrantRow[];
  subscriptions: SubscriptionRow[];
  membershipPlans?: MembershipPlanRow[];
  truncatedTables?: string[];
};

/**
 * Per-table ceiling of the paged scan. Staging reached 10k ledger rows in its first four weeks of load tests; 100k leaves
 * months of headroom inside the 60-second daily job (about 100 sequential 1000-row pages for the largest table). Above
 * it the scan is reported as truncated exactly as before; moving these checks into a database aggregation is the
 * post-launch follow-up.
 */
export const DEFAULT_READINESS_ROW_LIMIT = 100_000;
/** PostgREST's default max-rows: a page is never silently cut by the server. */
const READINESS_PAGE_ROWS = 1000;

/**
 * Reads a whole table in id order, one page at a time, up to `rowLimit` rows (REL-1 2026-10-26: a single read of 5000 rows
 * stopped covering billing_history after a few thousand paid calls, so the reservation check went permanently red and the
 * balance check silently off). A page shorter than asked ends the scan; the exact count of the first page still exposes a
 * server cap below the page size as a truncated scan instead of a silently partial one.
 */
export async function readLimitedRows<T extends { id?: string | null }>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  rowLimit: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let exactCount: number | null = null;
  let after: string | null = null;
  for (;;) {
    const want = Math.min(READINESS_PAGE_ROWS, rowLimit + 1 - rows.length);
    let query = supabase.from(table).select(columns, after === null ? { count: 'exact' } : undefined).order('id', { ascending: true });
    if (after !== null) query = query.gt('id', after);
    const result = await query.limit(want);
    if (result.error) throw result.error;
    if (after === null && typeof result.count === 'number') exactCount = result.count;
    const page = (result.data ?? []) as unknown as T[];
    rows.push(...page);
    const last = page.at(-1)?.id;
    if (page.length < want || rows.length > rowLimit || typeof last !== 'string') break;
    after = last;
  }
  const kept = rows.slice(0, rowLimit);
  return {
    rows: kept,
    truncated: rows.length > rowLimit || (exactCount !== null && exactCount > kept.length),
  };
}
