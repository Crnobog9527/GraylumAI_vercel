import type { SupabaseClient } from '@supabase/supabase-js';
import {
  countsAsCreditSpend,
  normalizeCreditLedgerType,
  countsAsTopupPurchaseCredit,
} from './creditLedger';
import {
  PAYMENT_ORDER_STATUSES,
  normalizePaymentOrderStatus,
} from './paymentOrderStatus';
import { getDueAnnualGrantPeriods } from './subscriptionCreditGrants';

export interface BillingReconciliationSummary {
  successfulAiRequests: number;
  tokenStatsCount: number;
  tokenStatsCredits: number;
  settledCredits: number;
  deductionCredits: number;
  completedPaymentOrders: number;
  completedPaymentAmount: number;
  purchaseCredits: number;
  webSearchCount: number;
}

export interface BillingReconciliationResult {
  periodStart: string;
  periodEnd: string;
  enforcementStart: string;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  launchBaselineAt: string | null;
  success: boolean;
  mismatches: string[];
  summary: BillingReconciliationSummary;
}

export type BillingReadinessFindingSeverity = 'error' | 'warning';

export interface BillingReadinessFinding {
  code: string;
  severity: BillingReadinessFindingSeverity;
  message: string;
  scope?: 'launch' | 'historical';
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingReadinessSummary {
  profilesScanned: number;
  creditTransactionsScanned: number;
  paymentOrdersScanned: number;
  subscriptionCreditGrantsScanned: number;
  subscriptionsScanned: number;
  profileLedgerMismatches: number;
  grantLedgerMismatches: number;
  duplicateActiveSubscriptionGroups: number;
  duplicateAnnualGrantPeriods: number;
  invalidPaymentOrderStatuses: number;
  stalePendingPaymentOrders: number;
  refundAuditGaps: number;
  duplicateIdempotencyKeys: number;
  invalidConsumedAmounts: number;
  paidUnfulfilledOrders: number;
  duplicateGrantGroups: number;
  refundTerminationGaps: number;
  historicalFindings: number;
  truncatedTables: string[];
}

export interface BillingReadinessAuditResult {
  success: boolean;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  launchBaselineAt: string | null;
  checkedAt: string;
  findings: BillingReadinessFinding[];
  historicalFindings: BillingReadinessFinding[];
  summary: BillingReadinessSummary;
  options: {
    pendingOrderMaxAgeHours: number;
    rowLimit: number;
  };
}

export interface BillingReadinessAuditOptions {
  now?: Date;
  pendingOrderMaxAgeHours?: number;
  rowLimit?: number;
  launchBaselineAt?: Date;
}

type ProfileRow = {
  id?: string | null;
  credits?: number | string | null;
};

type CreditTransactionRow = {
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

type PaymentOrderRow = {
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
};

type SubscriptionCreditGrantRow = {
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

type SubscriptionRow = {
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

type MembershipPlanRow = {
  id?: string | null;
  yearly_credits?: number | string | null;
};

type BillingReadinessRows = {
  profiles: ProfileRow[];
  creditTransactions: CreditTransactionRow[];
  paymentOrders: PaymentOrderRow[];
  subscriptionCreditGrants: SubscriptionCreditGrantRow[];
  subscriptions: SubscriptionRow[];
  membershipPlans?: MembershipPlanRow[];
  truncatedTables?: string[];
};

const DEFAULT_READINESS_PENDING_MAX_AGE_HOURS = 48;
const DEFAULT_READINESS_ROW_LIMIT = 5000;
const CANONICAL_PAYMENT_ORDER_STATUS_SET = new Set<string>(PAYMENT_ORDER_STATUSES);
const LEGACY_PAYMENT_ORDER_STATUS_SET = new Set<string>(['cancelled', 'partial_refunded']);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set<string>(['active', 'trialing']);
const PAYMENT_ATTENTION_SUBSCRIPTION_STATUSES = new Set<string>(['past_due', 'incomplete', 'unpaid']);
const ANNUAL_RELEASE_REFUND_BLOCKING_STATUSES = new Set<string>([
  'refunded',
  'partially_refunded',
  'partial_refunded',
]);
const REFUNDED_PAYMENT_ORDER_STATUSES = new Set<string>([
  'refunded',
  'partially_refunded',
  'partial_refunded',
]);
export const LAUNCH_BASELINE_SETTING_KEY = 'launch_baseline_at';

export type LaunchBaselineReadResult =
  | {
    status: 'READY';
    launchBaselineAt: Date;
    launchBaselineAtIso: string;
  }
  | {
    status: 'BLOCKED';
    reason: 'MISSING' | 'INVALID' | 'READ_FAILED';
    launchBaselineAt: null;
    launchBaselineAtIso: null;
  };

function sumInteger(values: Array<number | string | null | undefined>) {
  return values.reduce<number>((sum, value) => {
    if (typeof value === 'number') return sum + value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? sum + parsed : sum;
    }
    return sum;
  }, 0);
}

export function getUtcPreviousDayWindow(targetDate?: Date) {
  const base = targetDate ? new Date(targetDate) : new Date();
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function parseLaunchBaselineAt(value: unknown): LaunchBaselineReadResult {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      status: 'BLOCKED',
      reason: 'MISSING',
      launchBaselineAt: null,
      launchBaselineAtIso: null,
    };
  }

  const launchBaselineAt = new Date(value);
  if (!Number.isFinite(launchBaselineAt.getTime())) {
    return {
      status: 'BLOCKED',
      reason: 'INVALID',
      launchBaselineAt: null,
      launchBaselineAtIso: null,
    };
  }

  return {
    status: 'READY',
    launchBaselineAt,
    launchBaselineAtIso: launchBaselineAt.toISOString(),
  };
}

export async function readLaunchBaselineAt(
  supabase: SupabaseClient,
): Promise<LaunchBaselineReadResult> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', LAUNCH_BASELINE_SETTING_KEY)
    .maybeSingle();

  if (error) {
    return {
      status: 'BLOCKED',
      reason: 'READ_FAILED',
      launchBaselineAt: null,
      launchBaselineAtIso: null,
    };
  }

  return parseLaunchBaselineAt(data?.value);
}

function toInteger(value: number | string | null | undefined) {
  return sumInteger([value]);
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasGenericRefundAuditSignal(value: unknown): boolean {
  const record = asRecord(value);
  const reversalStatus = normalizeText(record.reversalStatus);
  const reconciliationStatus = normalizeText(record.reconciliationStatus);
  return (
    record.fullRefund === true
    || record.reviewRequired === true
    || typeof record.refundId === 'string'
    || Boolean(reversalStatus && reversalStatus !== 'pending')
    || Boolean(reconciliationStatus && reconciliationStatus !== 'pending')
    || typeof record.idempotencyKey === 'string'
    || typeof record.status === 'string'
  );
}

function hasSubscriptionGrantReversalAuditSignal(value: unknown): boolean {
  const record = asRecord(value);
  const reversalStatus = normalizeText(record.reversalStatus);
  if (!reversalStatus || reversalStatus === 'pending') {
    return false;
  }
  return (
    reversalStatus === 'complete'
    || reversalStatus === 'review_required'
    || reversalStatus.endsWith('_review_required')
  );
}

function hasPendingSubscriptionGrantReversal(value: unknown): boolean {
  return normalizeText(asRecord(value).reversalStatus) === 'pending';
}

function hasRefundAuditMetadata(order: PaymentOrderRow) {
  const metadata = asRecord(order.metadata);
  const subscriptionGrantReversal = metadata.subscriptionCreditGrantReversal;
  if (hasPendingSubscriptionGrantReversal(subscriptionGrantReversal)) {
    return false;
  }

  return (
    hasGenericRefundAuditSignal(metadata.stripeRefundReconciliation)
    || hasSubscriptionGrantReversalAuditSignal(subscriptionGrantReversal)
    || hasGenericRefundAuditSignal(metadata.stripeRefundWebhookAudit)
    || hasGenericRefundAuditSignal(metadata.refundReconciliation)
    || hasGenericRefundAuditSignal(metadata.refund)
  );
}

function getInvoiceId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasFullRefundSignal(value: unknown, invoiceId?: string | null): boolean {
  const record = asRecord(value);
  if (record.fullRefund !== true) {
    return false;
  }

  const scopedInvoiceId = getInvoiceId(invoiceId);
  if (!scopedInvoiceId) {
    return true;
  }

  return getInvoiceId(record.invoiceId) === scopedInvoiceId;
}

function isFullRefundedSubscriptionOrder(order: PaymentOrderRow) {
  if (!isMembershipSubscriptionOrder(order)) {
    return false;
  }

  const status = getRawPaymentOrderStatus(order.status);
  const paymentStatus = getRawPaymentOrderStatus(order.payment_status);
  if (status === 'refunded' || paymentStatus === 'refunded') {
    return true;
  }

  const metadata = asRecord(order.metadata);
  return (
    hasFullRefundSignal(metadata.stripeRefundReconciliation)
    || hasFullRefundSignal(metadata.subscriptionCreditGrantReversal)
    || hasFullRefundSignal(metadata.refundReconciliation)
    || hasFullRefundSignal(metadata.refund)
  );
}

function isAnnualReleaseRefundBlockedOrderForInvoice(order: PaymentOrderRow, invoiceId: string) {
  if (!isMembershipSubscriptionOrder(order)) {
    return false;
  }

  const scopedInvoiceId = getInvoiceId(invoiceId);
  if (!scopedInvoiceId) {
    return false;
  }

  const orderInvoiceId = getInvoiceId(order.stripe_invoice_id);
  const status = getRawPaymentOrderStatus(order.status);
  const paymentStatus = getRawPaymentOrderStatus(order.payment_status);
  if (
    orderInvoiceId === scopedInvoiceId
    && (
      ANNUAL_RELEASE_REFUND_BLOCKING_STATUSES.has(status)
      || ANNUAL_RELEASE_REFUND_BLOCKING_STATUSES.has(paymentStatus)
    )
  ) {
    return true;
  }

  const metadata = asRecord(order.metadata);
  return (
    hasFullRefundSignal(metadata.stripeRefundReconciliation, scopedInvoiceId)
    || hasFullRefundSignal(metadata.subscriptionCreditGrantReversal, scopedInvoiceId)
    || hasFullRefundSignal(metadata.refundReconciliation, scopedInvoiceId)
    || hasFullRefundSignal(metadata.refund, scopedInvoiceId)
  );
}

function getRawPaymentOrderStatus(value: unknown) {
  return normalizeText(value);
}

function isKnownPaymentOrderStatus(value: unknown) {
  const rawStatus = getRawPaymentOrderStatus(value);
  return CANONICAL_PAYMENT_ORDER_STATUS_SET.has(rawStatus) || LEGACY_PAYMENT_ORDER_STATUS_SET.has(rawStatus);
}

function isMembershipSubscriptionOrder(order: PaymentOrderRow) {
  return (
    order.item_type === 'membership_plan'
    || order.mode === 'subscription'
    || Boolean(order.stripe_subscription_id)
  );
}

function isActiveSubscription(row: SubscriptionRow, now: Date) {
  const status = normalizeText(row.status);
  if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
    return true;
  }

  if (PAYMENT_ATTENTION_SUBSCRIPTION_STATUSES.has(status)) {
    return true;
  }

  if ((row.cancel_at_period_end === true || row.cancel_at_period_end === 'true') && row.current_period_end) {
    const periodEnd = Date.parse(row.current_period_end);
    return Number.isFinite(periodEnd) && periodEnd > now.getTime();
  }

  return false;
}

function isAnnualReleaseEligibleSubscription(row: SubscriptionRow) {
  return (
    row.billing_cycle === 'yearly'
    && Boolean(row.stripe_subscription_id)
    && ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeText(row.status))
  );
}

function getAnnualReleaseInvoiceId(subscription: SubscriptionRow) {
  return getInvoiceId(asRecord(subscription.metadata).lastInvoiceId);
}

function getAnnualSubscriptionYearlyCredits(
  subscription: SubscriptionRow,
  yearlyCreditsByPlanId: Map<string, number>,
): number | null {
  const planId = subscription.membership_plan_id?.trim();
  if (!planId) {
    return null;
  }

  return yearlyCreditsByPlanId.get(planId) ?? null;
}

function addFinding(
  findings: BillingReadinessFinding[],
  finding: BillingReadinessFinding,
) {
  findings.push(finding);
}

function addDuplicateIdempotencyFindings<T>(
  findings: BillingReadinessFinding[],
  rows: T[],
  getKey: (row: T) => string | null | undefined,
  entityType: string,
  getScope?: (row: T) => string | null | undefined,
) {
  const grouped = new Map<string, T[]>();
  const groupMetadata = new Map<string, { key: string; scope: string | null }>();
  for (const row of rows) {
    const key = getKey(row)?.trim();
    if (!key) {
      continue;
    }

    const scope = getScope?.(row)?.trim() || null;
    const groupKey = scope ? `${scope}:${key}` : key;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), row]);
    groupMetadata.set(groupKey, { key, scope });
  }

  for (const [groupKey, duplicates] of grouped.entries()) {
    if (duplicates.length <= 1) {
      continue;
    }

    const metadata = groupMetadata.get(groupKey) ?? { key: groupKey, scope: null };
    addFinding(findings, {
      code: 'duplicate_idempotency_key',
      severity: 'error',
      message: metadata.scope
        ? `${entityType} idempotency key ${metadata.key} appears ${duplicates.length} times for ${metadata.scope}`
        : `${entityType} idempotency key ${metadata.key} appears ${duplicates.length} times`,
      entityType,
      metadata: { idempotencyKey: metadata.key, scope: metadata.scope, count: duplicates.length },
    });
  }
}

async function readLimitedRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  rowLimit: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const result = await supabase
    .from(table)
    .select(columns, { count: 'exact' })
    .limit(rowLimit + 1);

  if (result.error) throw result.error;

  const fetchedRows = (result.data ?? []) as T[];
  const rows = fetchedRows.slice(0, rowLimit);
  const exactCount = typeof result.count === 'number' ? result.count : null;
  return {
    rows,
    truncated: fetchedRows.length > rowLimit || (exactCount !== null && exactCount > rows.length),
  };
}

function emptyReadinessSummary(): BillingReadinessSummary {
  return {
    profilesScanned: 0,
    creditTransactionsScanned: 0,
    paymentOrdersScanned: 0,
    subscriptionCreditGrantsScanned: 0,
    subscriptionsScanned: 0,
    profileLedgerMismatches: 0,
    grantLedgerMismatches: 0,
    duplicateActiveSubscriptionGroups: 0,
    duplicateAnnualGrantPeriods: 0,
    invalidPaymentOrderStatuses: 0,
    stalePendingPaymentOrders: 0,
    refundAuditGaps: 0,
    duplicateIdempotencyKeys: 0,
    invalidConsumedAmounts: 0,
    paidUnfulfilledOrders: 0,
    duplicateGrantGroups: 0,
    refundTerminationGaps: 0,
    historicalFindings: 0,
    truncatedTables: [],
  };
}

function buildBlockedReadinessAudit(
  reason: 'MISSING' | 'INVALID' | 'READ_FAILED',
  options: BillingReadinessAuditOptions,
): BillingReadinessAuditResult {
  const now = options.now ?? new Date();
  const pendingOrderMaxAgeHours = options.pendingOrderMaxAgeHours ?? DEFAULT_READINESS_PENDING_MAX_AGE_HOURS;
  const rowLimit = options.rowLimit ?? DEFAULT_READINESS_ROW_LIMIT;
  const code = reason === 'MISSING'
    ? 'launch_baseline_missing'
    : reason === 'INVALID'
      ? 'launch_baseline_invalid'
      : 'launch_baseline_read_failed';

  return {
    success: false,
    status: 'BLOCKED',
    launchBaselineAt: null,
    checkedAt: now.toISOString(),
    findings: [{
      code,
      severity: 'error',
      scope: 'launch',
      message: `BLOCKED: ${LAUNCH_BASELINE_SETTING_KEY} is ${reason.toLowerCase()}`,
      entityType: 'system_settings',
      entityId: LAUNCH_BASELINE_SETTING_KEY,
    }],
    historicalFindings: [],
    summary: emptyReadinessSummary(),
    options: {
      pendingOrderMaxAgeHours,
      rowLimit,
    },
  };
}

function getTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCreatedAtMs(value: { created_at?: string | null }): number | null {
  return getTimestampMs(value.created_at);
}

function isProfileLedgerMismatchHistorical(
  profileId: string,
  rows: BillingReadinessRows,
  launchBaselineAt: Date,
): boolean {
  const profile = rows.profiles.find((row) => row.id === profileId);
  if (!profile) return false;

  // profiles has no mutation timestamp. Only ledger snapshots can establish a
  // pre-baseline offset; old rows or a valid Launch-only chain are not proof.
  const ledgerInteger = (value: number | string | null | undefined): number | null => {
    if (typeof value === 'string' && !value.trim()) return null;
    const parsed = toFiniteNumber(value);
    return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
  };
  const profileCredits = ledgerInteger(profile.credits);
  if (profileCredits === null) return false;

  const baselineMs = launchBaselineAt.getTime();
  const transactions = rows.creditTransactions
    .filter((row) => row.user_id === profileId)
    .map((row) => ({ row, timestamp: getCreatedAtMs(row), amount: ledgerInteger(row.amount) }));
  if (transactions.some(({ timestamp, amount }) => timestamp === null || amount === null)) return false;
  transactions.sort((left, right) => (left.timestamp as number) - (right.timestamp as number));
  // Equal timestamps have no authoritative ordering in this schema. Do not
  // invent one from query order or UUIDs when proving balance continuity.
  if (transactions.some((entry, index) => index > 0 && entry.timestamp === transactions[index - 1].timestamp)) {
    return false;
  }

  const historicalTransactions = transactions.filter(({ timestamp }) => (timestamp as number) < baselineMs);
  const anchor = historicalTransactions[historicalTransactions.length - 1];
  if (!anchor) return false;
  const anchorBefore = ledgerInteger(anchor.row.balance_before);
  const anchorAfter = ledgerInteger(anchor.row.balance_after);
  const historicalTotal = historicalTransactions.reduce((total, entry) => total + (entry.amount as number), 0);
  if (
    anchorBefore === null || anchorAfter === null
    || anchorAfter !== anchorBefore + (anchor.amount as number)
    || !Number.isSafeInteger(historicalTotal)
  ) return false;
  const historicalOffset = anchorAfter - historicalTotal;
  if (!Number.isSafeInteger(historicalOffset) || historicalOffset === 0) return false;

  let previousBalanceAfter = anchorAfter;
  let ledgerTotal = historicalTotal;
  for (const { row: transaction, amount } of transactions.filter(({ timestamp }) => (timestamp as number) >= baselineMs)) {
    const balanceBefore = ledgerInteger(transaction.balance_before);
    const balanceAfter = ledgerInteger(transaction.balance_after);
    if (
      balanceBefore === null
      || balanceAfter === null
      || amount === null
      || balanceAfter !== balanceBefore + amount
      || balanceBefore !== previousBalanceAfter
    ) {
      return false;
    }
    ledgerTotal += amount;
    if (!Number.isSafeInteger(ledgerTotal)) return false;
    previousBalanceAfter = balanceAfter;
  }

  return previousBalanceAfter === profileCredits
    && profileCredits - ledgerTotal === historicalOffset;
}

function immutableRowsForFinding(
  finding: BillingReadinessFinding,
  rows: BillingReadinessRows,
): Array<{ created_at?: string | null }> {
  if (finding.code === 'duplicate_idempotency_key') {
    const key = typeof finding.metadata?.idempotencyKey === 'string'
      ? finding.metadata.idempotencyKey
      : null;
    if (!key) return [];
    if (finding.entityType === 'credit_transactions') {
      const scope = typeof finding.metadata?.scope === 'string' ? finding.metadata.scope : null;
      return rows.creditTransactions.filter((row) => (
        row.idempotency_key === key && (!scope || row.user_id === scope)
      ));
    }
    if (finding.entityType === 'subscription_credit_grants') {
      return rows.subscriptionCreditGrants.filter((row) => row.idempotency_key === key);
    }
  }

  if (finding.code === 'duplicate_active_subscription') {
    const ids = Array.isArray(finding.metadata?.subscriptionIds)
      ? finding.metadata.subscriptionIds
      : [];
    return rows.subscriptions.filter((row) => row.id && ids.includes(row.id));
  }

  if (finding.code === 'duplicate_annual_grant_period' || finding.code === 'duplicate_subscription_grant') {
    const ids = Array.isArray(finding.metadata?.grantIds) ? finding.metadata.grantIds : [];
    return rows.subscriptionCreditGrants.filter((row) => row.id && ids.includes(row.id));
  }

  if (!finding.entityId) return [];
  if (finding.entityType === 'credit_transactions') {
    return rows.creditTransactions.filter((row) => row.id === finding.entityId);
  }
  if (finding.entityType === 'payment_orders') {
    return rows.paymentOrders.filter((row) => row.id === finding.entityId);
  }
  if (finding.entityType === 'subscription_credit_grants') {
    const grants = rows.subscriptionCreditGrants.filter((row) => row.id === finding.entityId);
    if (finding.code !== 'subscription_grant_credit_transaction_mismatch') return grants;
    const transactionIds = new Set(
      grants
        .map((grant) => grant.credit_transaction_id)
        .filter((value): value is string => Boolean(value)),
    );
    return [
      ...grants,
      ...rows.creditTransactions.filter((row) => row.id && transactionIds.has(row.id)),
    ];
  }
  if (finding.entityType === 'user_subscriptions') {
    return rows.subscriptions.filter((row) => row.id === finding.entityId);
  }
  return [];
}

const CREATE_TIME_DEFINED_FINDINGS = new Set([
  'refund_clawback_counts_as_spend',
  'subscription_grant_missing_credit_transaction',
  'subscription_grant_credit_transaction_mismatch',
  'subscription_grant_transaction_orphaned',
  'annual_monthly_release_period_invalid',
  'duplicate_annual_grant_period',
  'duplicate_subscription_grant',
  'duplicate_idempotency_key',
]);

type TimestampProof = 'HISTORICAL' | 'LAUNCH' | 'UNKNOWN';

function timestampFieldsProof(
  record: Record<string, unknown>,
  fieldNames: string[],
  baselineMs: number,
): TimestampProof {
  const timestamps: number[] = [];
  for (const fieldName of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(record, fieldName)) continue;
    const timestamp = getTimestampMs(record[fieldName]);
    if (timestamp === null) return 'LAUNCH';
    timestamps.push(timestamp);
  }

  if (timestamps.length === 0) return 'UNKNOWN';
  return timestamps.every((timestamp) => timestamp < baselineMs)
    ? 'HISTORICAL'
    : 'LAUNCH';
}

function updatedAtProof(
  row: { updated_at?: string | null },
  baselineMs: number,
): TimestampProof {
  const updatedAtMs = getTimestampMs(row.updated_at);
  if (updatedAtMs === null) return 'UNKNOWN';
  return updatedAtMs < baselineMs ? 'HISTORICAL' : 'LAUNCH';
}

function paymentStatusProof(order: PaymentOrderRow, baselineMs: number): TimestampProof {
  const metadata = asRecord(order.metadata);
  if (
    normalizeText(metadata.paymentStatus) === normalizeText(order.payment_status)
    && normalizeText(metadata.lastPaymentOrderStatus) === normalizeText(order.status)
    && Object.prototype.hasOwnProperty.call(metadata, 'lastPaymentOrderStatusAt')
  ) {
    return timestampFieldsProof(metadata, ['lastPaymentOrderStatusAt'], baselineMs);
  }
  return updatedAtProof(order, baselineMs);
}

function paymentOrderStateProof(order: PaymentOrderRow, baselineMs: number): TimestampProof {
  const metadata = asRecord(order.metadata);
  if (
    normalizeText(metadata.lastPaymentOrderStatus) === normalizeText(order.status)
    && Object.prototype.hasOwnProperty.call(metadata, 'lastPaymentOrderStatusAt')
  ) {
    return timestampFieldsProof(metadata, ['lastPaymentOrderStatusAt'], baselineMs);
  }
  return updatedAtProof(order, baselineMs);
}

function refundStateProof(order: PaymentOrderRow, baselineMs: number): TimestampProof {
  const metadata = asRecord(order.metadata);
  const candidates: Array<{ active: boolean; record: Record<string, unknown>; fields: string[] }> = [
    {
      active: hasSubscriptionGrantReversalAuditSignal(metadata.subscriptionCreditGrantReversal),
      record: asRecord(metadata.subscriptionCreditGrantReversal),
      fields: ['refundCreatedAt', 'reconciledAt'],
    },
    {
      active: hasGenericRefundAuditSignal(metadata.stripeRefundReconciliation),
      record: asRecord(metadata.stripeRefundReconciliation),
      fields: ['refundCreatedAt', 'reconciledAt'],
    },
    {
      active: hasGenericRefundAuditSignal(metadata.refundReconciliation),
      record: asRecord(metadata.refundReconciliation),
      fields: ['refundCreatedAt', 'reconciledAt'],
    },
    {
      active: hasGenericRefundAuditSignal(metadata.refund),
      record: asRecord(metadata.refund),
      fields: ['refundCreatedAt', 'createdAt', 'reconciledAt'],
    },
  ];

  const candidate = candidates.find((entry) => entry.active);
  if (candidate) {
    const proof = timestampFieldsProof(candidate.record, candidate.fields, baselineMs);
    if (proof !== 'UNKNOWN') return proof;
  }

  // updated_at is only an upper-bound proof here: a pre-baseline last mutation
  // proves the current refund state predates Launch. A missing or later value is
  // ambiguous and therefore remains Launch-blocking.
  return updatedAtProof(order, baselineMs);
}

function findPaymentOrder(
  finding: BillingReadinessFinding,
  rows: BillingReadinessRows,
): PaymentOrderRow | null {
  if (finding.entityType !== 'payment_orders' || !finding.entityId) return null;
  return rows.paymentOrders.find((row) => row.id === finding.entityId) ?? null;
}

function findGrant(
  finding: BillingReadinessFinding,
  rows: BillingReadinessRows,
): SubscriptionCreditGrantRow | null {
  if (finding.entityType !== 'subscription_credit_grants' || !finding.entityId) return null;
  return rows.subscriptionCreditGrants.find((row) => row.id === finding.entityId) ?? null;
}

function isHistoricalFinding(
  finding: BillingReadinessFinding,
  rows: BillingReadinessRows,
  launchBaselineAt: Date,
  pendingOrderMaxAgeHours: number,
): boolean {
  if (finding.severity === 'warning') return false;
  const baselineMs = launchBaselineAt.getTime();
  if (finding.code === 'profile_ledger_balance_mismatch' && finding.entityId) {
    return isProfileLedgerMismatchHistorical(finding.entityId, rows, launchBaselineAt);
  }

  if (CREATE_TIME_DEFINED_FINDINGS.has(finding.code)) {
    const sourceRows = immutableRowsForFinding(finding, rows);
    if (sourceRows.length === 0) return false;
    const timestamps = sourceRows.map(getCreatedAtMs);
    return timestamps.every((timestamp) => timestamp !== null && timestamp < baselineMs);
  }

  const paymentOrder = findPaymentOrder(finding, rows);
  if (finding.code === 'stale_pending_payment_order' && paymentOrder) {
    const createdAtMs = getCreatedAtMs(paymentOrder);
    if (createdAtMs === null) return false;
    const staleAtMs = createdAtMs + pendingOrderMaxAgeHours * 60 * 60 * 1000;
    return staleAtMs < baselineMs
      && paymentOrderStateProof(paymentOrder, baselineMs) === 'HISTORICAL';
  }

  if (finding.code === 'payment_order_paid_unfulfilled' && paymentOrder) {
    return paymentStatusProof(paymentOrder, baselineMs) === 'HISTORICAL';
  }

  if (finding.code === 'refund_termination_gap' && paymentOrder) {
    return refundStateProof(paymentOrder, baselineMs) === 'HISTORICAL';
  }

  if (
    (finding.code === 'invalid_payment_order_status'
      || finding.code === 'subscription_refund_audit_metadata_missing')
    && paymentOrder
  ) {
    return paymentOrderStateProof(paymentOrder, baselineMs) === 'HISTORICAL';
  }

  if (finding.code === 'subscription_grant_consumed_amount_invalid') {
    const grant = findGrant(finding, rows);
    // Every known consumed_amount mutation updates this row's updated_at. A
    // pre-baseline value therefore proves the invalid state is legacy; a
    // missing or later value cannot prove that and remains Launch-blocking.
    return grant !== null && updatedAtProof(grant, baselineMs) === 'HISTORICAL';
  }

  if (finding.code === 'duplicate_active_subscription') {
    const ids = Array.isArray(finding.metadata?.subscriptionIds)
      ? finding.metadata.subscriptionIds
      : [];
    const subscriptions = rows.subscriptions.filter((row) => row.id && ids.includes(row.id));
    return subscriptions.length > 0 && subscriptions.every((row) => (
      updatedAtProof(row, baselineMs) === 'HISTORICAL'
    ));
  }

  // Dynamic readiness findings (for example, a currently due annual grant)
  // have no trustworthy pre-baseline formation timestamp. Fail closed.
  return false;
}

export function buildBillingEngineV15ReadinessAudit(
  rows: BillingReadinessRows,
  options: BillingReadinessAuditOptions = {},
): BillingReadinessAuditResult {
  if (options.launchBaselineAt && !Number.isFinite(options.launchBaselineAt.getTime())) {
    return buildBlockedReadinessAudit('INVALID', options);
  }

  const now = options.now ?? new Date();
  const pendingOrderMaxAgeHours = options.pendingOrderMaxAgeHours ?? DEFAULT_READINESS_PENDING_MAX_AGE_HOURS;
  const rowLimit = options.rowLimit ?? DEFAULT_READINESS_ROW_LIMIT;
  const stalePendingBeforeMs = now.getTime() - pendingOrderMaxAgeHours * 60 * 60 * 1000;
  const truncatedTables = rows.truncatedTables ?? [];
  const hasTruncatedBalanceInput = truncatedTables.includes('profiles') || truncatedTables.includes('credit_transactions');
  const hasTruncatedGrantCrossTableInput = (
    truncatedTables.includes('credit_transactions')
    || truncatedTables.includes('subscription_credit_grants')
  );
  const hasTruncatedAnnualReleaseInput = (
    truncatedTables.includes('payment_orders')
    || truncatedTables.includes('membership_plans')
    || truncatedTables.includes('subscription_credit_grants')
    || truncatedTables.includes('user_subscriptions')
  );
  const findings: BillingReadinessFinding[] = [];
  const creditTransactionsById = new Map(
    rows.creditTransactions
      .filter((transaction) => transaction.id)
      .map((transaction) => [transaction.id as string, transaction]),
  );
  const yearlyCreditsByPlanId = new Map(
    (rows.membershipPlans ?? [])
      .filter((plan) => plan.id)
      .map((plan) => [plan.id as string, toInteger(plan.yearly_credits)]),
  );

  for (const table of truncatedTables) {
    addFinding(findings, {
      code: 'readiness_scan_truncated',
      severity: 'warning',
      message: `${table} exceeded the PR7 readiness scan row limit (${rowLimit}); audit result is partial`,
      entityType: table,
      metadata: { rowLimit },
    });
  }

  const ledgerTotalsByUser = new Map<string, number>();
  for (const transaction of rows.creditTransactions) {
    if (!transaction.user_id) {
      continue;
    }

    ledgerTotalsByUser.set(
      transaction.user_id,
      (ledgerTotalsByUser.get(transaction.user_id) ?? 0) + toInteger(transaction.amount),
    );
  }

  if (!hasTruncatedBalanceInput) {
    for (const profile of rows.profiles) {
      if (!profile.id) {
        continue;
      }

      const profileCredits = toInteger(profile.credits);
      const ledgerCredits = ledgerTotalsByUser.get(profile.id) ?? 0;
      if (profileCredits !== ledgerCredits) {
        addFinding(findings, {
          code: 'profile_ledger_balance_mismatch',
          severity: 'error',
          message: `Profile credits (${profileCredits}) do not match credit ledger sum (${ledgerCredits})`,
          entityType: 'profiles',
          entityId: profile.id,
          metadata: { profileCredits, ledgerCredits },
        });
      }
    }
  }

  for (const order of rows.paymentOrders) {
    const rawStatus = getRawPaymentOrderStatus(order.status);
    const normalizedStatus = normalizePaymentOrderStatus(order.status);
    if (rawStatus && !isKnownPaymentOrderStatus(order.status)) {
      addFinding(findings, {
        code: 'invalid_payment_order_status',
        severity: 'error',
        message: `Payment order status ${rawStatus} is outside the Billing Engine v1.5 status vocabulary`,
        entityType: 'payment_orders',
        entityId: order.id ?? undefined,
        metadata: { status: order.status },
      });
    }

    if (normalizedStatus === 'pending' && !order.fulfilled_at && order.created_at) {
      const createdAt = Date.parse(order.created_at);
      if (Number.isFinite(createdAt) && createdAt < stalePendingBeforeMs) {
        addFinding(findings, {
          code: 'stale_pending_payment_order',
          severity: 'error',
          message: `Pending payment order is older than ${pendingOrderMaxAgeHours} hours`,
          entityType: 'payment_orders',
          entityId: order.id ?? undefined,
          metadata: {
            createdAt: order.created_at,
            pendingOrderMaxAgeHours,
          },
        });
      }
    }

    if (isMembershipSubscriptionOrder(order) && (
      normalizedStatus === 'refunded'
      || normalizedStatus === 'partially_refunded'
      || normalizePaymentOrderStatus(order.payment_status) === 'refunded'
      || normalizePaymentOrderStatus(order.payment_status) === 'partially_refunded'
    ) && !hasRefundAuditMetadata(order)) {
      addFinding(findings, {
        code: 'subscription_refund_audit_metadata_missing',
        severity: 'error',
        message: 'Refunded subscription payment order is missing refund reconciliation audit metadata',
        entityType: 'payment_orders',
        entityId: order.id ?? undefined,
        metadata: {
          status: order.status,
          paymentStatus: order.payment_status,
          stripeInvoiceId: order.stripe_invoice_id ?? null,
        },
      });
    }

    if (options.launchBaselineAt && normalizeText(order.payment_status) === 'paid' && !order.fulfilled_at) {
      addFinding(findings, {
        code: 'payment_order_paid_unfulfilled',
        severity: 'error',
        message: 'Paid payment order has not been fulfilled',
        entityType: 'payment_orders',
        entityId: order.id ?? undefined,
        metadata: {
          paymentStatus: order.payment_status ?? null,
          stripeSubscriptionId: order.stripe_subscription_id ?? null,
        },
      });
    }

    const isRefundedOrder = (
      REFUNDED_PAYMENT_ORDER_STATUSES.has(normalizeText(order.status))
      || REFUNDED_PAYMENT_ORDER_STATUSES.has(normalizeText(order.payment_status))
    );
    if (options.launchBaselineAt && isMembershipSubscriptionOrder(order) && isRefundedOrder) {
      const subscriptionId = order.stripe_subscription_id?.trim();
      const matchingSubscription = subscriptionId
        ? rows.subscriptions.find((subscription) => (
          subscription.stripe_subscription_id === subscriptionId
        ))
        : null;
      if (!matchingSubscription?.credit_release_terminated_at) {
        addFinding(findings, {
          code: 'refund_termination_gap',
          severity: 'error',
          message: 'Refunded subscription order has no matching credit-release termination',
          entityType: 'payment_orders',
          entityId: order.id ?? undefined,
          metadata: {
            stripeSubscriptionId: subscriptionId ?? null,
            subscriptionRowId: matchingSubscription?.id ?? null,
          },
        });
      }
    }
  }

  for (const transaction of rows.creditTransactions) {
    const ledgerType = normalizeCreditLedgerType(transaction);
    if (ledgerType === 'refund_clawback' && transaction.counts_as_spend === true) {
      addFinding(findings, {
        code: 'refund_clawback_counts_as_spend',
        severity: 'error',
        message: 'Refund clawback ledger entry must not count as monthly AI spend',
        entityType: 'credit_transactions',
        entityId: transaction.id ?? undefined,
      });
    }
  }

  for (const grant of rows.subscriptionCreditGrants) {
    if (options.launchBaselineAt) {
      const creditsGranted = toFiniteNumber(grant.credits_granted);
      const consumedAmount = toFiniteNumber(grant.consumed_amount);
      if (
        creditsGranted === null
        || consumedAmount === null
        || !Number.isInteger(creditsGranted)
        || !Number.isInteger(consumedAmount)
        || consumedAmount < 0
        || consumedAmount > creditsGranted
      ) {
        addFinding(findings, {
          code: 'subscription_grant_consumed_amount_invalid',
          severity: 'error',
          message: 'Subscription grant violates 0 <= consumed_amount <= credits_granted',
          entityType: 'subscription_credit_grants',
          entityId: grant.id ?? undefined,
          metadata: {
            creditsGranted: grant.credits_granted ?? null,
            consumedAmount: grant.consumed_amount ?? null,
          },
        });
      }
    }

    if (normalizeText(grant.status) !== 'granted') {
      continue;
    }

    if (!grant.credit_transaction_id) {
      addFinding(findings, {
        code: 'subscription_grant_missing_credit_transaction',
        severity: 'error',
        message: 'Granted subscription_credit_grants row has no matching credit transaction',
        entityType: 'subscription_credit_grants',
        entityId: grant.id ?? undefined,
        metadata: {
          creditTransactionId: grant.credit_transaction_id ?? null,
          grantPeriodKey: grant.grant_period_key ?? null,
        },
      });
      continue;
    }

    if (!hasTruncatedGrantCrossTableInput) {
      const transaction = creditTransactionsById.get(grant.credit_transaction_id);
      if (!transaction) {
        addFinding(findings, {
          code: 'subscription_grant_missing_credit_transaction',
          severity: 'error',
          message: 'Granted subscription_credit_grants row has no matching credit transaction',
          entityType: 'subscription_credit_grants',
          entityId: grant.id ?? undefined,
          metadata: {
            creditTransactionId: grant.credit_transaction_id,
            grantPeriodKey: grant.grant_period_key ?? null,
          },
        });
      } else {
        const grantCredits = toInteger(grant.credits_granted);
        const transactionAmount = toInteger(transaction.amount);
        const transactionLedgerType = normalizeCreditLedgerType(transaction);
        const transactionReasonCode = transaction.reason_code ?? '';
        const grantPeriodKey = grant.grant_period_key?.trim() ?? '';
        const transactionGrantPeriodKey = transaction.grant_period_key?.trim() ?? '';
        const grantUserId = grant.user_id?.trim() ?? '';
        const transactionUserId = transaction.user_id?.trim() ?? '';
        if (
          transactionAmount !== grantCredits
          || transactionLedgerType !== 'grant'
          || transaction.counts_as_spend === true
          || (transactionReasonCode !== 'subscription_grant' && transactionReasonCode !== 'annual_monthly_release')
          || (grantPeriodKey && transactionGrantPeriodKey !== grantPeriodKey)
          || (grantUserId && transactionUserId !== grantUserId)
        ) {
          addFinding(findings, {
            code: 'subscription_grant_credit_transaction_mismatch',
            severity: 'error',
            message: 'Granted subscription_credit_grants row does not match its credit transaction semantics',
            entityType: 'subscription_credit_grants',
            entityId: grant.id ?? undefined,
            metadata: {
              creditTransactionId: grant.credit_transaction_id,
              grantCredits,
              transactionAmount,
              ledgerType: transactionLedgerType,
              reasonCode: transactionReasonCode,
              grantPeriodKey: grantPeriodKey || null,
              transactionGrantPeriodKey: transactionGrantPeriodKey || null,
              grantUserId: grantUserId || null,
              transactionUserId: transactionUserId || null,
            },
          });
        }
      }
    }

    if (grant.grant_type === 'annual_monthly_release') {
      const periodIndex = toInteger(grant.period_index);
      const totalPeriods = toInteger(grant.total_periods);
      if (grant.billing_cycle !== 'yearly' || periodIndex < 1 || periodIndex > 12 || totalPeriods !== 12) {
        addFinding(findings, {
          code: 'annual_monthly_release_period_invalid',
          severity: 'error',
          message: 'Annual monthly release grant has invalid cycle or period metadata',
          entityType: 'subscription_credit_grants',
          entityId: grant.id ?? undefined,
          metadata: {
            billingCycle: grant.billing_cycle ?? null,
            periodIndex,
            totalPeriods,
          },
        });
      }
    }
  }

  if (options.launchBaselineAt) {
    const grantedRowsByPeriod = new Map<string, SubscriptionCreditGrantRow[]>();
    for (const grant of rows.subscriptionCreditGrants) {
      if (
        normalizeText(grant.status) !== 'granted'
        || !grant.stripe_subscription_id?.trim()
        || !grant.grant_period_key?.trim()
      ) {
        continue;
      }
      const key = `${grant.stripe_subscription_id.trim()}:${grant.grant_period_key.trim()}`;
      grantedRowsByPeriod.set(key, [...(grantedRowsByPeriod.get(key) ?? []), grant]);
    }

    for (const [key, grants] of grantedRowsByPeriod.entries()) {
      if (grants.length <= 1) continue;
      addFinding(findings, {
        code: 'duplicate_subscription_grant',
        severity: 'error',
        message: `Subscription grant period ${key} has ${grants.length} granted rows`,
        entityType: 'subscription_credit_grants',
        metadata: {
          key,
          grantIds: grants.map((grant) => grant.id ?? null),
        },
      });
    }
  }

  const grantRowsByTransactionId = new Set(
    rows.subscriptionCreditGrants
      .map((grant) => grant.credit_transaction_id)
      .filter((value): value is string => Boolean(value)),
  );
  const grantRowsByIdempotencyKey = new Set(
    rows.subscriptionCreditGrants
      .map((grant) => grant.idempotency_key)
      .filter((value): value is string => Boolean(value)),
  );
  for (const transaction of rows.creditTransactions) {
    const reasonCode = transaction.reason_code ?? '';
    const isSubscriptionGrantTransaction = (
      reasonCode === 'subscription_grant'
      || reasonCode === 'annual_monthly_release'
      || transaction.idempotency_key?.startsWith('subscription_grant:')
    );
    if (!isSubscriptionGrantTransaction) {
      continue;
    }

    if (hasTruncatedGrantCrossTableInput) {
      continue;
    }

    const hasGrantRow = (
      (transaction.id ? grantRowsByTransactionId.has(transaction.id) : false)
      || (transaction.idempotency_key ? grantRowsByIdempotencyKey.has(transaction.idempotency_key) : false)
    );
    if (!hasGrantRow) {
      addFinding(findings, {
        code: 'subscription_grant_transaction_orphaned',
        severity: 'error',
        message: 'Subscription grant credit transaction has no matching subscription_credit_grants row',
        entityType: 'credit_transactions',
        entityId: transaction.id ?? undefined,
        metadata: {
          reasonCode,
          idempotencyKey: transaction.idempotency_key ?? null,
        },
      });
    }
  }

  const activeSubscriptionsByUser = new Map<string, SubscriptionRow[]>();
  for (const subscription of rows.subscriptions) {
    if (!subscription.user_id || !isActiveSubscription(subscription, now)) {
      continue;
    }

    activeSubscriptionsByUser.set(
      subscription.user_id,
      [...(activeSubscriptionsByUser.get(subscription.user_id) ?? []), subscription],
    );
  }

  for (const [userId, subscriptions] of activeSubscriptionsByUser.entries()) {
    if (subscriptions.length <= 1) {
      continue;
    }

    addFinding(findings, {
      code: 'duplicate_active_subscription',
      severity: 'error',
      message: `User has ${subscriptions.length} active Stripe-managed subscription rows`,
      entityType: 'user_subscriptions',
      entityId: userId,
      metadata: {
        subscriptionIds: subscriptions.map((subscription) => subscription.id ?? null),
        stripeSubscriptionIds: subscriptions.map((subscription) => subscription.stripe_subscription_id ?? null),
      },
    });
  }

  const activeAnnualGrantPeriods = new Map<string, SubscriptionCreditGrantRow[]>();
  const annualGrantKeysBySubscriptionInvoice = new Map<string, Set<string>>();
  for (const grant of rows.subscriptionCreditGrants) {
    if (
      normalizeText(grant.status) !== 'granted'
      || grant.grant_type !== 'annual_monthly_release'
      || !grant.stripe_subscription_id
      || !grant.grant_period_key
    ) {
      continue;
    }

    const key = `${grant.stripe_subscription_id}:${grant.grant_period_key}`;
    activeAnnualGrantPeriods.set(key, [...(activeAnnualGrantPeriods.get(key) ?? []), grant]);
    const invoiceId = getInvoiceId(grant.stripe_invoice_id);
    if (invoiceId) {
      const invoiceKey = `${grant.stripe_subscription_id}:${invoiceId}`;
      const subscriptionInvoiceKeys = annualGrantKeysBySubscriptionInvoice.get(invoiceKey) ?? new Set<string>();
      subscriptionInvoiceKeys.add(grant.grant_period_key);
      annualGrantKeysBySubscriptionInvoice.set(invoiceKey, subscriptionInvoiceKeys);
    }
  }

  for (const [key, grants] of activeAnnualGrantPeriods.entries()) {
    if (grants.length <= 1) {
      continue;
    }

    addFinding(findings, {
      code: 'duplicate_annual_grant_period',
      severity: 'error',
      message: `Annual monthly release period ${key} has ${grants.length} active grant rows`,
      entityType: 'subscription_credit_grants',
      metadata: {
        key,
        grantIds: grants.map((grant) => grant.id ?? null),
      },
    });
  }

  if (!hasTruncatedAnnualReleaseInput) {
    for (const subscription of rows.subscriptions) {
      const subscriptionId = subscription.stripe_subscription_id;
      if (
        !subscriptionId
        || !isAnnualReleaseEligibleSubscription(subscription)
      ) {
        continue;
      }

      const invoiceId = getAnnualReleaseInvoiceId(subscription);
      if (!invoiceId) {
        addFinding(findings, {
          code: 'annual_monthly_release_invoice_scope_missing',
          severity: 'error',
          message: 'Active annual subscription is missing current invoice scope for monthly release readiness audit',
          entityType: 'user_subscriptions',
          entityId: subscription.id ?? undefined,
          metadata: {
            stripeSubscriptionId: subscriptionId,
          },
        });
        continue;
      }

      const hasRefundBlocker = rows.paymentOrders.some((order) => (
        order.stripe_subscription_id === subscriptionId
        && isAnnualReleaseRefundBlockedOrderForInvoice(order, invoiceId)
      ));
      if (hasRefundBlocker) {
        continue;
      }

      const yearlyCredits = getAnnualSubscriptionYearlyCredits(subscription, yearlyCreditsByPlanId);
      if (yearlyCredits === null) {
        addFinding(findings, {
          code: 'annual_monthly_release_plan_scope_missing',
          severity: 'error',
          message: 'Active annual subscription is missing membership plan credit schedule for monthly release readiness audit',
          entityType: 'user_subscriptions',
          entityId: subscription.id ?? undefined,
          metadata: {
            stripeSubscriptionId: subscriptionId,
            membershipPlanId: subscription.membership_plan_id ?? null,
          },
        });
        continue;
      }
      if (yearlyCredits < 0) {
        addFinding(findings, {
          code: 'annual_monthly_release_plan_schedule_invalid',
          severity: 'error',
          message: 'Active annual subscription has an invalid negative membership plan credit schedule for monthly release readiness audit',
          entityType: 'user_subscriptions',
          entityId: subscription.id ?? undefined,
          metadata: {
            stripeSubscriptionId: subscriptionId,
            membershipPlanId: subscription.membership_plan_id ?? null,
            yearlyCredits,
          },
        });
        continue;
      }

      const dueGrantPeriodKeys = getDueAnnualGrantPeriods({
          yearlyCredits,
          stripeSubscriptionId: subscriptionId,
          currentPeriodStart: subscription.current_period_start ?? '',
          currentPeriodEnd: subscription.current_period_end ?? '',
          now,
        })
        .filter((period) => period.creditsGranted > 0)
        .map((period) => period.grantPeriodKey);
      if (dueGrantPeriodKeys.length === 0) {
        continue;
      }

      const grantedPeriodKeys = annualGrantKeysBySubscriptionInvoice.get(`${subscriptionId}:${invoiceId}`) ?? new Set<string>();
      const missingGrantPeriodKeys = dueGrantPeriodKeys.filter((key) => !grantedPeriodKeys.has(key));
      if (missingGrantPeriodKeys.length === 0) {
        continue;
      }

      addFinding(findings, {
        code: 'annual_monthly_release_period_missing',
        severity: 'error',
        message: 'Active annual subscription is missing due monthly release grant periods',
        entityType: 'user_subscriptions',
        entityId: subscription.id ?? undefined,
        metadata: {
          stripeSubscriptionId: subscriptionId,
          dueGrantPeriodCount: dueGrantPeriodKeys.length,
          missingGrantPeriodKeys,
        },
      });
    }
  }

  addDuplicateIdempotencyFindings(
    findings,
    rows.creditTransactions,
    (transaction) => transaction.idempotency_key,
    'credit_transactions',
    (transaction) => transaction.user_id,
  );
  addDuplicateIdempotencyFindings(
    findings,
    rows.subscriptionCreditGrants,
    (grant) => grant.idempotency_key,
    'subscription_credit_grants',
  );

  const historicalSourceFindings = options.launchBaselineAt
    ? findings
      .filter((finding) => isHistoricalFinding(
        finding,
        rows,
        options.launchBaselineAt as Date,
        pendingOrderMaxAgeHours,
      ))
    : [];
  const historicalFindingSet = new Set(historicalSourceFindings);
  const historicalFindings = historicalSourceFindings
    .map((finding) => ({ ...finding, scope: 'historical' as const }));
  const enforcedFindings = options.launchBaselineAt
    ? findings
      .filter((finding) => !historicalFindingSet.has(finding))
      .map((finding) => ({ ...finding, scope: 'launch' as const }))
    : findings;

  const countFindings = (code: string) => enforcedFindings.filter((finding) => finding.code === code).length;
  const summary: BillingReadinessSummary = {
    profilesScanned: rows.profiles.length,
    creditTransactionsScanned: rows.creditTransactions.length,
    paymentOrdersScanned: rows.paymentOrders.length,
    subscriptionCreditGrantsScanned: rows.subscriptionCreditGrants.length,
    subscriptionsScanned: rows.subscriptions.length,
    profileLedgerMismatches: countFindings('profile_ledger_balance_mismatch'),
    grantLedgerMismatches: countFindings('subscription_grant_missing_credit_transaction')
      + countFindings('subscription_grant_credit_transaction_mismatch')
      + countFindings('subscription_grant_transaction_orphaned')
      + countFindings('annual_monthly_release_period_missing')
      + countFindings('annual_monthly_release_period_invalid')
      + countFindings('annual_monthly_release_invoice_scope_missing')
      + countFindings('annual_monthly_release_plan_scope_missing')
      + countFindings('annual_monthly_release_plan_schedule_invalid'),
    duplicateActiveSubscriptionGroups: countFindings('duplicate_active_subscription'),
    duplicateAnnualGrantPeriods: countFindings('duplicate_annual_grant_period'),
    invalidPaymentOrderStatuses: countFindings('invalid_payment_order_status'),
    stalePendingPaymentOrders: countFindings('stale_pending_payment_order'),
    refundAuditGaps: countFindings('subscription_refund_audit_metadata_missing')
      + countFindings('refund_clawback_counts_as_spend'),
    duplicateIdempotencyKeys: countFindings('duplicate_idempotency_key'),
    invalidConsumedAmounts: countFindings('subscription_grant_consumed_amount_invalid'),
    paidUnfulfilledOrders: countFindings('payment_order_paid_unfulfilled'),
    duplicateGrantGroups: countFindings('duplicate_subscription_grant'),
    refundTerminationGaps: countFindings('refund_termination_gap'),
    historicalFindings: historicalFindings.length,
    truncatedTables,
  };

  const success = !enforcedFindings.some((finding) => finding.severity === 'error');

  return {
    success,
    status: success ? 'SUCCESS' : 'FAILED',
    launchBaselineAt: options.launchBaselineAt?.toISOString() ?? null,
    checkedAt: now.toISOString(),
    findings: enforcedFindings,
    historicalFindings,
    summary,
    options: {
      pendingOrderMaxAgeHours,
      rowLimit,
    },
  };
}

export async function runBillingEngineV15ReadinessAudit(
  supabase: SupabaseClient,
  options: BillingReadinessAuditOptions = {},
): Promise<BillingReadinessAuditResult> {
  const rowLimit = options.rowLimit ?? DEFAULT_READINESS_ROW_LIMIT;
  const baselineResult = options.launchBaselineAt
    ? parseLaunchBaselineAt(
      Number.isFinite(options.launchBaselineAt.getTime())
        ? options.launchBaselineAt.toISOString()
        : 'invalid',
    )
    : await readLaunchBaselineAt(supabase);
  if (baselineResult.status === 'BLOCKED') {
    return buildBlockedReadinessAudit(baselineResult.reason, options);
  }

  const [
    profilesResult,
    creditTransactionsResult,
    paymentOrdersResult,
    subscriptionCreditGrantsResult,
    subscriptionsResult,
    membershipPlansResult,
  ] = await Promise.all([
    readLimitedRows<ProfileRow>(supabase, 'profiles', 'id, credits', rowLimit),
    readLimitedRows<CreditTransactionRow>(
      supabase,
      'credit_transactions',
      'id, user_id, amount, type, ledger_type, reason_code, counts_as_spend, source_type, source_order_id, grant_period_key, idempotency_key, balance_before, balance_after, metadata, created_at',
      rowLimit,
    ),
    readLimitedRows<PaymentOrderRow>(
      supabase,
      'payment_orders',
      'id, user_id, item_type, mode, status, payment_status, amount_total, fulfilled_at, created_at, updated_at, stripe_subscription_id, stripe_invoice_id, metadata',
      rowLimit,
    ),
    readLimitedRows<SubscriptionCreditGrantRow>(
      supabase,
      'subscription_credit_grants',
      'id, user_id, stripe_subscription_id, stripe_invoice_id, billing_cycle, grant_type, grant_period_key, period_index, total_periods, credits_granted, consumed_amount, accounting_state, status, idempotency_key, credit_transaction_id, metadata, created_at, updated_at',
      rowLimit,
    ),
    readLimitedRows<SubscriptionRow>(
      supabase,
      'user_subscriptions',
      'id, user_id, membership_plan_id, stripe_subscription_id, status, cancel_at_period_end, billing_cycle, current_period_start, current_period_end, credit_release_terminated_at, credit_release_terminated_reason, credit_release_terminated_event_id, credit_release_terminated_period_key, metadata, created_at, updated_at',
      rowLimit,
    ),
    readLimitedRows<MembershipPlanRow>(
      supabase,
      'membership_plans',
      'id, yearly_credits',
      rowLimit,
    ),
  ]);

  const truncatedTables = [
    profilesResult.truncated ? 'profiles' : null,
    creditTransactionsResult.truncated ? 'credit_transactions' : null,
    paymentOrdersResult.truncated ? 'payment_orders' : null,
    subscriptionCreditGrantsResult.truncated ? 'subscription_credit_grants' : null,
    subscriptionsResult.truncated ? 'user_subscriptions' : null,
    membershipPlansResult.truncated ? 'membership_plans' : null,
  ].filter((table): table is string => Boolean(table));

  return buildBillingEngineV15ReadinessAudit({
    profiles: profilesResult.rows,
    creditTransactions: creditTransactionsResult.rows,
    paymentOrders: paymentOrdersResult.rows,
    subscriptionCreditGrants: subscriptionCreditGrantsResult.rows,
    subscriptions: subscriptionsResult.rows,
    membershipPlans: membershipPlansResult.rows,
    truncatedTables,
  }, {
    ...options,
    rowLimit,
    launchBaselineAt: baselineResult.launchBaselineAt,
  });
}

export async function runDailyBillingReconciliation(
  supabase: SupabaseClient,
  targetDate?: Date,
  launchBaselineAt?: Date,
): Promise<BillingReconciliationResult> {
  const { start, end } = getUtcPreviousDayWindow(targetDate);
  const baselineResult = launchBaselineAt
    ? parseLaunchBaselineAt(
      Number.isFinite(launchBaselineAt.getTime()) ? launchBaselineAt.toISOString() : 'invalid',
    )
    : await readLaunchBaselineAt(supabase);
  if (baselineResult.status === 'BLOCKED') {
    return {
      periodStart: start,
      periodEnd: end,
      enforcementStart: start,
      status: 'BLOCKED',
      launchBaselineAt: null,
      success: false,
      mismatches: [
        `BLOCKED: ${LAUNCH_BASELINE_SETTING_KEY} is ${baselineResult.reason.toLowerCase()}`,
      ],
      summary: {
        successfulAiRequests: 0,
        tokenStatsCount: 0,
        tokenStatsCredits: 0,
        settledCredits: 0,
        deductionCredits: 0,
        completedPaymentOrders: 0,
        completedPaymentAmount: 0,
        purchaseCredits: 0,
        webSearchCount: 0,
      },
    };
  }

  const enforcementStart = new Date(Math.min(
    Math.max(Date.parse(start), baselineResult.launchBaselineAt.getTime()),
    Date.parse(end),
  )).toISOString();

  const [tokenStatsResult, aiUsageResult, billingHistoryResult, creditTransactionsResult, paymentOrdersResult] =
    await Promise.all([
      supabase
        .from('token_stats')
        .select('total_credits, web_search_count, created_at')
        .gte('created_at', enforcementStart)
        .lt('created_at', end),
      supabase
        .from('ai_usage_logs')
        .select('status, created_at')
        .eq('status', 'success')
        .gte('created_at', enforcementStart)
        .lt('created_at', end),
      supabase
        .from('billing_history')
        .select('operation_type, amount, created_at')
        .gte('created_at', enforcementStart)
        .lt('created_at', end),
      supabase
        .from('credit_transactions')
        .select('*')
        .gte('created_at', enforcementStart)
        .lt('created_at', end),
      supabase
        .from('payment_orders')
        .select('status, amount_total, created_at')
        .gte('created_at', enforcementStart)
        .lt('created_at', end),
    ]);

  if (tokenStatsResult.error) throw tokenStatsResult.error;
  if (aiUsageResult.error) throw aiUsageResult.error;
  if (billingHistoryResult.error) throw billingHistoryResult.error;
  if (creditTransactionsResult.error) throw creditTransactionsResult.error;
  if (paymentOrdersResult.error) throw paymentOrdersResult.error;

  const tokenStats = tokenStatsResult.data ?? [];
  const aiUsageLogs = aiUsageResult.data ?? [];
  const billingHistory = billingHistoryResult.data ?? [];
  const creditTransactions = creditTransactionsResult.data ?? [];
  const paymentOrders = paymentOrdersResult.data ?? [];

  const successfulAiRequests = aiUsageLogs.length;
  const tokenStatsCount = tokenStats.length;
  const tokenStatsCredits = sumInteger(tokenStats.map((row) => row.total_credits ?? 0));
  const webSearchCount = sumInteger(tokenStats.map((row) => row.web_search_count ?? 0));

  const settledCredits = Math.abs(sumInteger(
    billingHistory
      .filter((row) => row.operation_type === 'settle' || row.operation_type === 'abort_settle')
      .map((row) => row.amount ?? 0),
  ));

  const deductionCredits = Math.abs(sumInteger(
    creditTransactions
      .filter((row) => countsAsCreditSpend(row))
      .map((row) => row.amount ?? 0),
  ));

  const completedPaymentOrders = paymentOrders.filter((row) => row.status === 'completed');
  const purchaseCredits = sumInteger(
    creditTransactions
      .filter((row) => countsAsTopupPurchaseCredit(row))
      .map((row) => row.amount ?? 0),
  );

  const summary: BillingReconciliationSummary = {
    successfulAiRequests,
    tokenStatsCount,
    tokenStatsCredits,
    settledCredits,
    deductionCredits,
    completedPaymentOrders: completedPaymentOrders.length,
    completedPaymentAmount: sumInteger(completedPaymentOrders.map((row) => row.amount_total ?? 0)),
    purchaseCredits,
    webSearchCount,
  };

  const mismatches: string[] = [];
  if (successfulAiRequests !== tokenStatsCount) {
    mismatches.push(`AI success logs (${successfulAiRequests}) do not match token stats rows (${tokenStatsCount})`);
  }
  if (settledCredits !== tokenStatsCredits) {
    mismatches.push(`Billing settle credits (${settledCredits}) do not match token stats credits (${tokenStatsCredits})`);
  }
  if (deductionCredits < tokenStatsCredits) {
    mismatches.push(`Credit deductions (${deductionCredits}) are lower than token stats credits (${tokenStatsCredits})`);
  }
  if (completedPaymentOrders.length > 0 && purchaseCredits <= 0) {
    mismatches.push(`Completed payment orders (${completedPaymentOrders.length}) have no matching purchase credits`);
  }

  return {
    periodStart: start,
    periodEnd: end,
    enforcementStart,
    status: mismatches.length === 0 ? 'SUCCESS' : 'FAILED',
    launchBaselineAt: baselineResult.launchBaselineAtIso,
    success: mismatches.length === 0,
    mismatches,
    summary,
  };
}
