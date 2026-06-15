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
  success: boolean;
  mismatches: string[];
  summary: BillingReconciliationSummary;
}

export type BillingReadinessFindingSeverity = 'error' | 'warning';

export interface BillingReadinessFinding {
  code: string;
  severity: BillingReadinessFindingSeverity;
  message: string;
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
  truncatedTables: string[];
}

export interface BillingReadinessAuditResult {
  success: boolean;
  checkedAt: string;
  findings: BillingReadinessFinding[];
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
  metadata?: unknown;
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
  status?: string | null;
  idempotency_key?: string | null;
  credit_transaction_id?: string | null;
  metadata?: unknown;
};

type SubscriptionRow = {
  id?: string | null;
  user_id?: string | null;
  stripe_subscription_id?: string | null;
  status?: string | null;
  cancel_at_period_end?: string | boolean | null;
  billing_cycle?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  metadata?: unknown;
};

type BillingReadinessRows = {
  profiles: ProfileRow[];
  creditTransactions: CreditTransactionRow[];
  paymentOrders: PaymentOrderRow[];
  subscriptionCreditGrants: SubscriptionCreditGrantRow[];
  subscriptions: SubscriptionRow[];
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

function getUtcDayWindow(targetDate?: Date) {
  const base = targetDate ? new Date(targetDate) : new Date();
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function toInteger(value: number | string | null | undefined) {
  return sumInteger([value]);
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

function getTimestamp(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildAnnualGrantPeriodKey(subscriptionId: string, periodStartMs: number, periodIndex: number) {
  return `${subscriptionId}:${new Date(periodStartMs).toISOString().slice(0, 7)}:${String(periodIndex).padStart(2, '0')}`;
}

function getDueAnnualGrantPeriodKeys(subscription: SubscriptionRow, now: Date) {
  const subscriptionId = subscription.stripe_subscription_id;
  const startMs = getTimestamp(subscription.current_period_start);
  const endMs = getTimestamp(subscription.current_period_end);
  if (!subscriptionId || startMs === null || endMs === null || endMs <= startMs) {
    return [];
  }

  const nowMs = now.getTime();
  if (nowMs < startMs) {
    return [];
  }

  const periodMs = (endMs - startMs) / 12;
  const dueCount = Math.min(12, Math.floor((Math.min(nowMs, endMs) - startMs) / periodMs) + 1);
  return Array.from({ length: dueCount }, (_, index) => {
    const periodIndex = index + 1;
    const periodStartMs = Math.round(startMs + periodMs * index);
    return buildAnnualGrantPeriodKey(subscriptionId, periodStartMs, periodIndex);
  });
}

function getAnnualReleaseInvoiceId(subscription: SubscriptionRow) {
  return getInvoiceId(asRecord(subscription.metadata).lastInvoiceId);
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

export function buildBillingEngineV15ReadinessAudit(
  rows: BillingReadinessRows,
  options: BillingReadinessAuditOptions = {},
): BillingReadinessAuditResult {
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
    || truncatedTables.includes('subscription_credit_grants')
    || truncatedTables.includes('user_subscriptions')
  );
  const findings: BillingReadinessFinding[] = [];
  const creditTransactionsById = new Map(
    rows.creditTransactions
      .filter((transaction) => transaction.id)
      .map((transaction) => [transaction.id as string, transaction]),
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

      const dueGrantPeriodKeys = getDueAnnualGrantPeriodKeys(subscription, now);
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

  const countFindings = (code: string) => findings.filter((finding) => finding.code === code).length;
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
      + countFindings('annual_monthly_release_invoice_scope_missing'),
    duplicateActiveSubscriptionGroups: countFindings('duplicate_active_subscription'),
    duplicateAnnualGrantPeriods: countFindings('duplicate_annual_grant_period'),
    invalidPaymentOrderStatuses: countFindings('invalid_payment_order_status'),
    stalePendingPaymentOrders: countFindings('stale_pending_payment_order'),
    refundAuditGaps: countFindings('subscription_refund_audit_metadata_missing')
      + countFindings('refund_clawback_counts_as_spend'),
    duplicateIdempotencyKeys: countFindings('duplicate_idempotency_key'),
    truncatedTables,
  };

  return {
    success: !findings.some((finding) => finding.severity === 'error'),
    checkedAt: now.toISOString(),
    findings,
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
  const [
    profilesResult,
    creditTransactionsResult,
    paymentOrdersResult,
    subscriptionCreditGrantsResult,
    subscriptionsResult,
  ] = await Promise.all([
    readLimitedRows<ProfileRow>(supabase, 'profiles', 'id, credits', rowLimit),
    readLimitedRows<CreditTransactionRow>(
      supabase,
      'credit_transactions',
      'id, user_id, amount, type, ledger_type, reason_code, counts_as_spend, source_type, source_order_id, grant_period_key, idempotency_key, metadata',
      rowLimit,
    ),
    readLimitedRows<PaymentOrderRow>(
      supabase,
      'payment_orders',
      'id, user_id, item_type, mode, status, payment_status, amount_total, fulfilled_at, created_at, stripe_subscription_id, stripe_invoice_id, metadata',
      rowLimit,
    ),
    readLimitedRows<SubscriptionCreditGrantRow>(
      supabase,
      'subscription_credit_grants',
      'id, user_id, stripe_subscription_id, stripe_invoice_id, billing_cycle, grant_type, grant_period_key, period_index, total_periods, credits_granted, status, idempotency_key, credit_transaction_id, metadata',
      rowLimit,
    ),
    readLimitedRows<SubscriptionRow>(
      supabase,
      'user_subscriptions',
      'id, user_id, stripe_subscription_id, status, cancel_at_period_end, billing_cycle, current_period_start, current_period_end, metadata',
      rowLimit,
    ),
  ]);

  const truncatedTables = [
    profilesResult.truncated ? 'profiles' : null,
    creditTransactionsResult.truncated ? 'credit_transactions' : null,
    paymentOrdersResult.truncated ? 'payment_orders' : null,
    subscriptionCreditGrantsResult.truncated ? 'subscription_credit_grants' : null,
    subscriptionsResult.truncated ? 'user_subscriptions' : null,
  ].filter((table): table is string => Boolean(table));

  return buildBillingEngineV15ReadinessAudit({
    profiles: profilesResult.rows,
    creditTransactions: creditTransactionsResult.rows,
    paymentOrders: paymentOrdersResult.rows,
    subscriptionCreditGrants: subscriptionCreditGrantsResult.rows,
    subscriptions: subscriptionsResult.rows,
    truncatedTables,
  }, {
    ...options,
    rowLimit,
  });
}

export async function runDailyBillingReconciliation(
  supabase: SupabaseClient,
  targetDate?: Date,
): Promise<BillingReconciliationResult> {
  const { start, end } = getUtcDayWindow(targetDate);

  const [tokenStatsResult, aiUsageResult, billingHistoryResult, creditTransactionsResult, paymentOrdersResult] =
    await Promise.all([
      supabase
        .from('token_stats')
        .select('total_credits, web_search_count, created_at')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('ai_usage_logs')
        .select('status, created_at')
        .eq('status', 'success')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('billing_history')
        .select('operation_type, amount, created_at')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('credit_transactions')
        .select('*')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('payment_orders')
        .select('status, amount_total, created_at')
        .gte('created_at', start)
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
    success: mismatches.length === 0,
    mismatches,
    summary,
  };
}
