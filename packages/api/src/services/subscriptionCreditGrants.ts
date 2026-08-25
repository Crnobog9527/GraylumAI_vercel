/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createHash } from 'crypto';
import { logger } from '../lib/logger';
import { normalizePaymentOrderStatus } from './paymentOrderStatus';
import {
  buildSubscriptionPlanChangeLockKey,
  isSubscriptionPlanChangeOrder,
} from './subscriptionPlanChangeLock';

type SupabaseLikeClient = any;
const STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS = 999;
const DETERMINISTIC_UUID_NAMESPACES = {
  subscriptionMirror: 'graylum:user_subscriptions:stripe_subscription_id:v1',
  invoicePaymentOrder: 'graylum:payment_orders:stripe_invoice_id:v1',
} as const;

export type SubscriptionBillingCycle = 'monthly' | 'yearly';
export type SubscriptionGrantType = 'monthly_invoice' | 'annual_monthly_release';
export type SubscriptionGrantSourceType = 'stripe_invoice' | 'system';

interface MembershipPlanRow {
  id: string;
  name?: string | null;
  level?: string | null;
  monthly_credits?: number | null;
  yearly_credits?: number | null;
  monthly_bonus_credits?: number | null;
}

interface PaymentOrderRow {
  id?: string | null;
  user_id?: string | null;
  item_id?: string | null;
  item_type?: string | null;
  billing_cycle?: string | null;
  status?: string | null;
  stripe_customer_id?: string | null;
  stripe_price_id?: string | null;
  stripe_checkout_session_id?: string | null;
  stripe_invoice_id?: string | null;
  stripe_subscription_id?: string | null;
  payment_status?: string | null;
  fulfilled_at?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface SubscriptionRow {
  id?: string | null;
  user_id?: string | null;
  membership_plan_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_customer_id?: string | null;
  stripe_price_id?: string | null;
  billing_cycle?: string | null;
  status?: string | null;
  cancel_at_period_end?: string | boolean | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  credit_release_terminated_at?: string | null;
  credit_release_terminated_reason?: string | null;
  credit_release_terminated_event_id?: string | null;
  credit_release_terminated_period_key?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface SubscriptionCreditGrantRow {
  id?: string | null;
  user_id?: string | null;
  membership_plan_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_invoice_id?: string | null;
  billing_cycle?: string | null;
  grant_type?: string | null;
  grant_period_key?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  period_index?: number | null;
  credits_granted?: number | null;
  consumed_amount?: number | null;
  status?: string | null;
  credit_transaction_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface CreditTransactionRow {
  id?: string | null;
  amount?: number | string | null;
}

interface ProfileCreditRow {
  id?: string | null;
  credits?: number | string | null;
}

interface GrantPeriod {
  periodIndex: number | null;
  totalPeriods: number;
  periodStart: string;
  periodEnd: string;
  grantPeriodKey: string;
  creditsGranted: number;
}

interface GrantSubscriptionCreditsInput extends GrantPeriod {
  userId: string;
  membershipPlanId: string | null;
  stripeSubscriptionId: string;
  stripeInvoiceId?: string | null;
  billingCycle: SubscriptionBillingCycle;
  grantType: SubscriptionGrantType;
  sourceType: SubscriptionGrantSourceType;
  sourceId?: string | null;
  sourceOrderId?: string | null;
  planName?: string | null;
  now?: string;
}

export interface FulfillMembershipInvoiceWithCreditGrantsInput {
  invoiceId: string;
  invoiceCreatedAt?: string | null;
  subscriptionId: string;
  amountTotal: number | null;
  currency?: string | null;
  paymentStatus?: string | null;
  stripeCustomerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  now?: string;
}

export interface AnnualReleaseResult {
  scannedSubscriptions: number;
  releasedGrantCount: number;
  releasedCredits: number;
  skippedSubscriptions: number;
}

export interface ReconcileSubscriptionRefundCreditGrantsInput {
  orderId: string;
  subscriptionId: string;
  refundId?: string | null;
  refundEventType?: string | null;
  refundStatus?: string | null;
  refundAmount?: number | null;
  refundCurrency?: string | null;
  invoiceId?: string | null;
  isFullRefund: boolean;
  eventId?: string | null;
  refundCreatedAt?: string | null;
  now?: string;
}

export interface SubscriptionRefundCreditGrantReconciliationResult {
  orderId: string;
  subscriptionId: string;
  refundId: string | null;
  fullRefund: boolean;
  reviewRequired: boolean;
  reviewReason: string | null;
  terminationWritten: boolean;
  terminatedAt: string | null;
  locatedPeriodKey: string | null;
  reversedGrantCount: number;
  clawbackAmount: number;
  appliedClawbackAmount: number;
  shortfallAmount: number;
  creditTransactionId: string | null;
  alreadyReconciled: boolean;
}

const SUBSCRIPTION_GRANT_ERRORS = {
  invoiceOrderLookup: 'Failed to look up subscription invoice order',
  subscriptionOrderLookup: 'Failed to look up subscription source order',
  membershipPlanLookup: 'Failed to look up membership plan for subscription grant',
  subscriptionLookup: 'Failed to look up annual subscriptions',
  refundLookup: 'Failed to check subscription refund state',
  creditGrantLookup: 'Failed to check subscription credit grant idempotency',
  creditGrantInsert: 'Failed to insert subscription credit grant',
  creditTransactionUpdate: 'Failed to update subscription credit transaction semantics',
  creditGrantRpc: 'Failed to apply subscription credit grant',
  paymentOrderWrite: 'Failed to write subscription invoice payment order',
  subscriptionWrite: 'Failed to write subscription mirror',
  profileWrite: 'Failed to update membership profile level',
  refundOrderLookup: 'Failed to look up subscription refund payment order',
  refundOrderWrite: 'Failed to update subscription refund payment order',
  refundCreditTransactionLookup: 'Failed to look up subscription refund clawback transaction',
  refundCreditTransactionUpdate: 'Failed to update subscription refund clawback transaction semantics',
  refundCreditGrantReversal: 'Failed to mark subscription credit grants reversed',
  missingSubscriptionOrder: 'Subscription source order is missing required billing fields',
  missingMembershipPlan: 'Membership plan is missing for subscription grant',
  missingMembershipPlanLevel: 'Membership plan level is missing for subscription grant',
  missingProfile: 'Profile is missing for membership invoice fulfillment',
} as const;

class SubscriptionCreditGrantError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly safeContext: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SubscriptionCreditGrantError';
  }
}

function maskIdentifier(value: string | null | undefined) {
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function summarizeSupabaseError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      code: null,
      message: typeof error === 'string' ? error.slice(0, 240) : null,
    };
  }

  const record = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return {
    code: typeof record.code === 'string' ? record.code : null,
    message: typeof record.message === 'string' ? record.message.slice(0, 240) : null,
    details: typeof record.details === 'string' ? record.details.slice(0, 240) : null,
    hint: typeof record.hint === 'string' ? record.hint.slice(0, 240) : null,
  };
}

function throwGrantError(
  stage: string,
  message: string,
  cause: unknown,
  context: Record<string, unknown> = {},
): never {
  const safeContext = {
    ...context,
    supabaseError: summarizeSupabaseError(cause),
  };

  logger.error('billing', 'subscription_credit_grant_stage_failed', {
    stage,
    ...safeContext,
  });

  throw new SubscriptionCreditGrantError(stage, message, safeContext, { cause });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getFirstRpcRow<T>(data: T[] | null | undefined): T | null {
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromMs(value: number) {
  return new Date(value).toISOString();
}

function normalizeIsoInstant(value: string) {
  const parsedMs = parseTime(value);
  return parsedMs === null ? value : isoFromMs(parsedMs);
}

/**
 * UTC 日历月加法，月末按目标月最后一天收敛（D6：01-31 → 02-28/29 → 03-31 → 04-30）。
 * 每期都从原始 anchor 计算，保留 anchor 的时分秒。
 */
export function addUtcCalendarMonthsClamped(anchor: Date, offset: number): Date {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }

  if (Number.isNaN(anchor.getTime())) {
    throw new Error('anchor must be a valid Date');
  }

  const targetMonthIndex = anchor.getUTCMonth() + offset;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(anchor.getUTCDate(), daysInTargetMonth);

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    clampedDay,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ));
}

function normalizeBillingCycle(value: string | null | undefined): SubscriptionBillingCycle {
  return value === 'yearly' ? 'yearly' : 'monthly';
}

function shouldInitializeMirrorStatus(value: string | null | undefined): boolean {
  return !value?.trim();
}

function shouldInitializeCancelAtPeriodEnd(value: string | boolean | null | undefined): boolean {
  return value === null || value === undefined || value === '';
}

function buildMonthlyGrantPeriodKey(invoiceId: string) {
  return `invoice:${invoiceId}`;
}

function buildAnnualGrantPeriodKey(termStartIso: string, periodIndex: number) {
  return `annual:${normalizeIsoInstant(termStartIso)}:${String(periodIndex).padStart(2, '0')}`;
}

function buildGrantIdempotencyKey(input: {
  billingCycle: SubscriptionBillingCycle;
  grantType: SubscriptionGrantType;
  stripeSubscriptionId: string;
  stripeInvoiceId?: string | null;
  grantPeriodKey: string;
}) {
  if (input.billingCycle === 'monthly' && input.stripeInvoiceId) {
    return `subscription_grant:monthly:${input.stripeInvoiceId}`;
  }

  return `subscription_grant:${input.grantType}:${input.stripeSubscriptionId}:${input.grantPeriodKey}`;
}

function getGrantReasonCode(grantType: SubscriptionGrantType) {
  return grantType === 'annual_monthly_release'
    ? 'annual_monthly_release'
    : 'subscription_grant';
}

function getGrantDescription(input: {
  planName?: string | null;
  billingCycle: SubscriptionBillingCycle;
  grantType: SubscriptionGrantType;
  periodIndex: number | null;
  totalPeriods: number;
  stripeInvoiceId?: string | null;
}) {
  const planName = input.planName?.trim() || 'membership plan';
  if (input.billingCycle === 'yearly') {
    return `Stripe 会员积分到账: ${planName} (年付第 ${input.periodIndex}/${input.totalPeriods} 期) [invoice:${input.stripeInvoiceId ?? 'scheduled'}]`;
  }

  return `Stripe 会员积分到账: ${planName} (月付) [invoice:${input.stripeInvoiceId ?? 'scheduled'}]`;
}

export function calculateAnnualMonthlyGrantSchedule(yearlyCredits: number): number[] {
  if (!Number.isInteger(yearlyCredits) || yearlyCredits < 0) {
    throw new Error('yearlyCredits must be a non-negative integer');
  }

  const base = Math.floor(yearlyCredits / 12);
  const remainder = yearlyCredits % 12;
  return Array.from({ length: 12 }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function calculateAnnualMonthlyGrant(yearlyCredits: number, periodIndex: number): number {
  if (!Number.isInteger(periodIndex) || periodIndex < 1 || periodIndex > 12) {
    throw new Error('periodIndex must be between 1 and 12');
  }

  return calculateAnnualMonthlyGrantSchedule(yearlyCredits)[periodIndex - 1];
}

/**
 * REFUND-1B: 预扣来源拆分（当期优先，封顶当期剩余额度）。
 * 与 0053 的 atomic_pre_deduct SQL 保持同一公式：
 *   amountToPeriod = min(amount, credits_granted - consumed)
 *   amountToOther  = amount - amountToPeriod
 */
export interface PreDeductPeriodBinding {
  chargedGrantId: string | null;
  chargedPeriodKey: string | null;
  amountToPeriod: number;
  amountToOther: number;
}

export function computePreDeductPeriodBinding(input: {
  amount: number;
  grant: {
    id: string;
    grantPeriodKey: string;
    creditsGranted: number;
    consumedAmount: number;
  } | null;
}): PreDeductPeriodBinding {
  if (!input.grant) {
    return {
      chargedGrantId: null,
      chargedPeriodKey: null,
      amountToPeriod: 0,
      amountToOther: input.amount,
    };
  }

  const remaining = Math.max(
    0,
    Math.floor(input.grant.creditsGranted) - Math.floor(input.grant.consumedAmount),
  );
  const amountToPeriod = Math.max(0, Math.min(Math.floor(input.amount), remaining));

  return {
    chargedGrantId: input.grant.id,
    chargedPeriodKey: input.grant.grantPeriodKey,
    amountToPeriod,
    amountToOther: Math.floor(input.amount) - amountToPeriod,
  };
}

/**
 * REFUND-1B: 结算/中止按预扣绑定的逆分配（其他来源先退，超出才逆减当期；
 * 超用吃绑定周期当前剩余额度而非 amountToPeriod 封顶；已 reversed 的周期
 * 拦截返还/追扣，不从其他来源补扣）。与 0053 各 atomic_* SQL 保持同一公式。
 */
export interface SettleAllocationResult {
  balanceDelta: number;
  periodConsumedDelta: number;
  otherRestore: number;
  periodRestore: number;
  overrunToPeriod: number;
  overrunToOther: number;
  refundInterceptedOverrun: number;
  refundInterceptedRestoration: number;
}

export function computeSettleAllocation(input: {
  reserved: number;
  actual: number;
  binding: { amountToPeriod: number; amountToOther: number } | null;
  grant: { creditsGranted: number; consumedAmount: number; status: string } | null;
}): SettleAllocationResult {
  const reserved = Math.floor(input.reserved);
  const actual = Math.floor(input.actual);
  const difference = reserved - actual;
  const empty: SettleAllocationResult = {
    balanceDelta: difference,
    periodConsumedDelta: 0,
    otherRestore: 0,
    periodRestore: 0,
    overrunToPeriod: 0,
    overrunToOther: 0,
    refundInterceptedOverrun: 0,
    refundInterceptedRestoration: 0,
  };

  if (!input.binding || !input.grant) {
    return empty;
  }

  const amountToPeriod = Math.max(0, Math.floor(input.binding.amountToPeriod));
  const amountToOther = Math.max(0, Math.floor(input.binding.amountToOther));

  if (input.grant.status === 'reversed') {
    if (difference >= 0) {
      const otherRestore = Math.min(difference, amountToOther);
      return {
        ...empty,
        balanceDelta: otherRestore,
        otherRestore,
        periodRestore: Math.min(Math.max(0, difference - amountToOther), amountToPeriod),
        refundInterceptedRestoration: Math.min(Math.max(0, difference - amountToOther), amountToPeriod),
      };
    }

    const overrun = actual - reserved;
    return {
      ...empty,
      balanceDelta: 0,
      refundInterceptedOverrun: overrun,
    };
  }

  if (difference >= 0) {
    const otherRestore = Math.min(difference, amountToOther);
    const periodRestore = Math.min(Math.max(0, difference - amountToOther), amountToPeriod);
    return {
      ...empty,
      balanceDelta: difference,
      periodConsumedDelta: -periodRestore,
      otherRestore,
      periodRestore,
    };
  }

  const overrun = actual - reserved;
  const remaining = Math.max(
    0,
    Math.floor(input.grant.creditsGranted) - Math.floor(input.grant.consumedAmount),
  );
  const overrunToPeriod = Math.min(overrun, remaining);

  return {
    ...empty,
    balanceDelta: -overrun,
    periodConsumedDelta: overrunToPeriod,
    overrunToPeriod,
    overrunToOther: overrun - overrunToPeriod,
  };
}

export function getDueAnnualGrantPeriods(input: {
  yearlyCredits: number;
  stripeSubscriptionId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  now?: Date;
}): GrantPeriod[] {
  const startMs = parseTime(input.currentPeriodStart);
  const endMs = parseTime(input.currentPeriodEnd);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return [];
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (nowMs < startMs) {
    return [];
  }

  const anchor = new Date(startMs);
  const termStartIso = anchor.toISOString();
  const schedule = calculateAnnualMonthlyGrantSchedule(input.yearlyCredits);

  return schedule.flatMap((creditsGranted, index): GrantPeriod[] => {
    const periodIndex = index + 1;
    const periodStart = addUtcCalendarMonthsClamped(anchor, index);
    if (periodStart.getTime() > nowMs) {
      return [];
    }

    return [{
      periodIndex,
      totalPeriods: 12,
      periodStart: periodStart.toISOString(),
      periodEnd: periodIndex === 12
        ? isoFromMs(endMs)
        : addUtcCalendarMonthsClamped(anchor, periodIndex).toISOString(),
      creditsGranted,
      grantPeriodKey: buildAnnualGrantPeriodKey(termStartIso, periodIndex),
    }];
  });
}

export function shouldReleaseAnnualSubscriptionCredits(input: {
  billingCycle?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  hasFullRefund?: boolean;
  creditReleaseTerminatedAt?: string | null;
  now?: Date;
}) {
  if (input.billingCycle !== 'yearly') {
    return false;
  }

  if (input.hasFullRefund) {
    return false;
  }

  // REFUND-1B: 退款 termination 已写入 → 立即停止未来释放
  if (input.creditReleaseTerminatedAt) {
    return false;
  }

  const status = (input.status ?? '').trim().toLowerCase();
  if (
    status === 'refunded'
    || status === 'canceled'
    || status === 'cancelled'
    || status === 'past_due'
    || status === 'incomplete'
    || status === 'incomplete_expired'
    || status === 'unpaid'
    || status === 'paused'
  ) {
    return false;
  }

  const periodEndMs = parseTime(input.currentPeriodEnd);
  const nowMs = (input.now ?? new Date()).getTime();
  if (periodEndMs !== null && nowMs >= periodEndMs) {
    return false;
  }

  return status === 'active' || status === 'trialing';
}

function asPaymentOrderRows(data: PaymentOrderRow | PaymentOrderRow[] | null | undefined): PaymentOrderRow[] {
  if (!data) {
    return [];
  }

  return Array.isArray(data) ? data : [data];
}

function buildDeterministicUuid(namespace: string, value: string) {
  const bytes = Uint8Array.from(createHash('sha256').update(`${namespace}:${value}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function buildSubscriptionMirrorId(subscriptionId: string) {
  return buildDeterministicUuid(DETERMINISTIC_UUID_NAMESPACES.subscriptionMirror, subscriptionId);
}

function buildInvoicePaymentOrderId(invoiceId: string) {
  return buildDeterministicUuid(DETERMINISTIC_UUID_NAMESPACES.invoicePaymentOrder, invoiceId);
}

function isUniqueViolationError(error: { code?: unknown; message?: unknown } | null | undefined) {
  return error?.code === '23505'
    || /duplicate key value violates unique constraint/i.test(String(error?.message ?? ''));
}

function asSubscriptionRows(data: SubscriptionRow | SubscriptionRow[] | null | undefined): SubscriptionRow[] {
  if (!data) {
    return [];
  }

  return Array.isArray(data) ? data : [data];
}

function preferCanonicalInvoiceOrder(orders: PaymentOrderRow[]) {
  return orders.find((order) => Boolean(order.fulfilled_at))
    ?? orders.find((order) => Boolean(order.id))
    ?? null;
}

function preferCanonicalSubscriptionMirror(subscriptions: SubscriptionRow[]) {
  return subscriptions.find((subscription) => subscription.status === 'active')
    ?? subscriptions.find((subscription) => Boolean(subscription.id))
    ?? null;
}

function logDuplicateSubscriptionMirrors(subscriptionId: string, subscriptions: SubscriptionRow[]) {
  if (subscriptions.length <= 1) {
    return;
  }

  logger.warn('billing', 'subscription_mirror_duplicate_detected', {
    subscriptionId: maskIdentifier(subscriptionId),
    subscriptionCount: subscriptions.length,
    canonicalSubscriptionId: maskIdentifier(preferCanonicalSubscriptionMirror(subscriptions)?.id),
  });
}

async function getExistingInvoiceOrder(supabase: SupabaseLikeClient, invoiceId: string): Promise<PaymentOrderRow | null> {
  const query = supabase
    .from('payment_orders')
    .select('id, user_id, item_id, item_type, billing_cycle, status, stripe_customer_id, stripe_price_id, stripe_checkout_session_id, stripe_invoice_id, stripe_subscription_id, payment_status, fulfilled_at, created_at, metadata')
    .eq('stripe_invoice_id', invoiceId);
  const orderedQuery = typeof query.order === 'function'
    ? query.order('created_at', { ascending: true })
    : query;
  const limitedQuery = typeof orderedQuery.limit === 'function' ? orderedQuery.limit(10) : orderedQuery;
  const result = typeof limitedQuery.then === 'function'
    ? await limitedQuery
    : await limitedQuery.maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_invoice_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.invoiceOrderLookup,
      result.error,
      { invoiceId: maskIdentifier(invoiceId) },
    );
  }

  const rows = asPaymentOrderRows(result.data);
  if (rows.length > 1) {
    logger.warn('billing', 'subscription_invoice_order_duplicate_detected', {
      invoiceId: maskIdentifier(invoiceId),
      orderCount: rows.length,
      canonicalOrderId: maskIdentifier(preferCanonicalInvoiceOrder(rows)?.id),
    });
  }

  return preferCanonicalInvoiceOrder(rows);
}

function isUsableMembershipSourceOrder(
  order: PaymentOrderRow | null | undefined,
): order is PaymentOrderRow & { user_id: string; item_id: string } {
  return Boolean(
    order?.user_id
    && order.item_id
    && (!order.item_type || order.item_type === 'membership_plan'),
  );
}

function getInvoiceOrderRefundBlockReason(order: PaymentOrderRow | null | undefined) {
  if (!order?.id) {
    return null;
  }

  const status = normalizePaymentOrderStatus(order.status);
  if (status === 'refunded') {
    return 'refunded_status';
  }

  const paymentStatus = normalizePaymentOrderStatus(order.payment_status);
  if (paymentStatus === 'refunded') {
    return 'refunded_payment_status';
  }

  const metadata = asRecord(order.metadata);
  const stripeRefund = asRecord(metadata.stripeRefundReconciliation);
  if (stripeRefund.reviewRequired === true) {
    return stripeRefund.fullRefund === true
      ? 'stripe_refund_review_required'
      : 'stripe_refund_partial_review_required';
  }
  if (stripeRefund.fullRefund === true) {
    return 'stripe_refund_full_refund_marker';
  }

  const grantReversal = asRecord(metadata.subscriptionCreditGrantReversal);
  if (grantReversal.reviewRequired === true) {
    const reversalStatus = typeof grantReversal.reversalStatus === 'string'
      ? grantReversal.reversalStatus
      : '';
    if (reversalStatus.includes('shortfall')) {
      return 'grant_reversal_shortfall';
    }

    return grantReversal.fullRefund === true
      ? 'grant_reversal_review_required'
      : 'grant_reversal_partial_review_required';
  }
  if (grantReversal.fullRefund === true) {
    const reversalStatus = typeof grantReversal.reversalStatus === 'string'
      ? grantReversal.reversalStatus
      : '';
    if (reversalStatus.includes('shortfall')) {
      return 'grant_reversal_shortfall';
    }

    return 'grant_reversal_full_refund_marker';
  }

  if (status === 'partially_refunded' || paymentStatus === 'partially_refunded') {
    return 'partial_refund_status';
  }

  return null;
}

type SubscriptionSourceOrderLookupResult = {
  order: PaymentOrderRow | null;
  blockedOrder: PaymentOrderRow | null;
  blockedReason: string | null;
};

function pickSubscriptionSourceOrder(
  orders: PaymentOrderRow[],
  options: {
    invoiceCreatedAt?: string | null;
    periodStart?: string | null;
  },
): SubscriptionSourceOrderLookupResult {
  let blockedOrder: PaymentOrderRow | null = null;
  let blockedReason: string | null = null;

  for (const order of orders) {
    if (order.status === 'failed' || !isUsableSourceForInvoice(order, options)) {
      continue;
    }

    const refundBlockReason = getInvoiceOrderRefundBlockReason(order);
    if (refundBlockReason) {
      blockedOrder ??= order;
      blockedReason ??= refundBlockReason;
      continue;
    }

    return {
      order,
      blockedOrder: null,
      blockedReason: null,
    };
  }

  return {
    order: null,
    blockedOrder,
    blockedReason,
  };
}

async function getLatestSubscriptionOrder(
  supabase: SupabaseLikeClient,
  subscriptionId: string,
  options: {
    invoiceCreatedAt?: string | null;
    periodStart?: string | null;
  } = {},
): Promise<SubscriptionSourceOrderLookupResult> {
  const sourceCutoff = getInvoiceSourceQueryCutoff(options);
  const query = supabase
    .from('payment_orders')
    .select('id, user_id, item_id, item_type, billing_cycle, status, stripe_customer_id, stripe_price_id, stripe_checkout_session_id, payment_status, created_at, metadata')
    .eq('stripe_subscription_id', subscriptionId);
  const cutoffQuery = sourceCutoff && typeof query.lte === 'function'
    ? query.lte('created_at', sourceCutoff)
    : query;
  const filteredQuery = typeof cutoffQuery.neq === 'function'
    ? cutoffQuery.neq('status', 'failed')
    : cutoffQuery;
  const orderedQuery = filteredQuery
    .order('created_at', { ascending: false });
  const canApplyLimitBeforeInvoiceFilter = !sourceCutoff || typeof query.lte === 'function';
  const limitedQuery = canApplyLimitBeforeInvoiceFilter && typeof orderedQuery.limit === 'function'
    ? orderedQuery.limit(10)
    : orderedQuery;
  const result = typeof limitedQuery.then === 'function'
    ? await limitedQuery
    : await limitedQuery.maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_source_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionOrderLookup,
      result.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  if (Array.isArray(result.data)) {
    return pickSubscriptionSourceOrder(result.data as PaymentOrderRow[], options);
  }

  const order = result.data as PaymentOrderRow | null;
  return pickSubscriptionSourceOrder(order ? [order] : [], options);
}

function isCreatedNoLaterThanWithTolerance(
  createdAt: string | null | undefined,
  referenceAt: string | null | undefined,
  toleranceMs = 0,
) {
  if (!createdAt || !referenceAt) {
    return false;
  }

  const createdTime = Date.parse(createdAt);
  const referenceTime = Date.parse(referenceAt);

  return Number.isFinite(createdTime)
    && Number.isFinite(referenceTime)
    && createdTime <= referenceTime + toleranceMs;
}

function getInvoiceSourceCutoff(options: {
  invoiceCreatedAt?: string | null;
  periodStart?: string | null;
}) {
  return options.invoiceCreatedAt ?? options.periodStart ?? null;
}

function getInvoiceSourceQueryCutoff(options: {
  invoiceCreatedAt?: string | null;
  periodStart?: string | null;
}) {
  const sourceCutoff = getInvoiceSourceCutoff(options);
  if (!sourceCutoff) {
    return null;
  }

  const parsedCutoff = Date.parse(sourceCutoff);
  return Number.isFinite(parsedCutoff)
    ? new Date(parsedCutoff + STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS).toISOString()
    : sourceCutoff;
}

function isUsableSourceForInvoice(
  order: PaymentOrderRow | null | undefined,
  options: {
    invoiceCreatedAt?: string | null;
    periodStart?: string | null;
  },
) {
  if (!order) {
    return true;
  }

  const sourceCutoff = getInvoiceSourceCutoff(options);
  if (!sourceCutoff) {
    return true;
  }

  return isCreatedNoLaterThanWithTolerance(
    order.created_at,
    sourceCutoff,
    STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS,
  );
}

async function getResidualSubscriptionPlanChangeLock(input: {
  supabase: SupabaseLikeClient;
  subscriptionId: string;
  sourceCutoff?: string | null;
}): Promise<PaymentOrderRow | null> {
  const lockKey = buildSubscriptionPlanChangeLockKey(input.subscriptionId);
  const result = await input.supabase
    .from('payment_orders')
    .select('id, stripe_checkout_session_id, status, payment_status, fulfilled_at, created_at, metadata')
    .eq('stripe_subscription_id', input.subscriptionId)
    .eq('stripe_checkout_session_id', lockKey)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_plan_change_lock_lookup',
      SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
      result.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  const order = result.data as PaymentOrderRow | null;
  if (!order || !isSubscriptionPlanChangeOrder(order)) {
    return null;
  }

  return isCreatedNoLaterThanWithTolerance(
    order.created_at,
    input.sourceCutoff,
    STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS,
  ) ? order : null;
}

async function getMembershipPlan(
  supabase: SupabaseLikeClient,
  planId: string,
): Promise<MembershipPlanRow> {
  const result = await supabase
    .from('membership_plans')
    .select('id, name, level, monthly_credits, yearly_credits, monthly_bonus_credits')
    .eq('id', planId)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_membership_plan_lookup',
      SUBSCRIPTION_GRANT_ERRORS.membershipPlanLookup,
      result.error,
      { membershipPlanId: maskIdentifier(planId) },
    );
  }

  if (!result.data) {
    throwGrantError(
      'subscription_membership_plan_missing',
      SUBSCRIPTION_GRANT_ERRORS.missingMembershipPlan,
      new Error('membership plan missing'),
      { membershipPlanId: maskIdentifier(planId) },
    );
  }

  return result.data;
}

function requireMembershipPlanLevel(plan: MembershipPlanRow, context: Record<string, unknown>): string {
  const level = plan.level?.trim();
  if (!level) {
    throwGrantError(
      'subscription_membership_plan_level_missing',
      SUBSCRIPTION_GRANT_ERRORS.missingMembershipPlanLevel,
      new Error('membership plan level missing'),
      context,
    );
  }

  return level;
}

async function syncProfileMembershipLevel(input: {
  supabase: SupabaseLikeClient;
  userId: string;
  membershipLevel: string;
  subscriptionId: string;
  invoiceId: string;
}) {
  const result = await input.supabase
    .from('profiles')
    .update({ membership_level: input.membershipLevel })
    .eq('id', input.userId)
    .select('id')
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_profile_membership_level_update',
      SUBSCRIPTION_GRANT_ERRORS.profileWrite,
      result.error,
      {
        userId: maskIdentifier(input.userId),
        subscriptionId: maskIdentifier(input.subscriptionId),
        invoiceId: maskIdentifier(input.invoiceId),
      },
    );
  }

  if (!result.data?.id) {
    throwGrantError(
      'subscription_profile_missing',
      SUBSCRIPTION_GRANT_ERRORS.missingProfile,
      new Error('profile missing for membership invoice fulfillment'),
      {
        userId: maskIdentifier(input.userId),
        subscriptionId: maskIdentifier(input.subscriptionId),
        invoiceId: maskIdentifier(input.invoiceId),
      },
    );
  }
}

async function hasSubscriptionFullRefund(
  supabase: SupabaseLikeClient,
  input: { subscriptionId: string; invoiceId?: string | null },
): Promise<boolean> {
  const subscriptionId = input.subscriptionId;
  const invoiceId = input.invoiceId?.trim() || null;
  const statusChecks = [
    { stage: 'subscription_full_refund_status_lookup', column: 'status', value: 'refunded' },
    { stage: 'subscription_full_refund_payment_status_lookup', column: 'payment_status', value: 'refunded' },
    { stage: 'subscription_refund_review_status_lookup', column: 'status', value: 'partially_refunded' },
    { stage: 'subscription_refund_review_legacy_status_lookup', column: 'status', value: 'partial_refunded' },
    {
      stage: 'subscription_refund_review_payment_status_lookup',
      column: 'payment_status',
      value: 'partially_refunded',
    },
    {
      stage: 'subscription_refund_review_legacy_payment_status_lookup',
      column: 'payment_status',
      value: 'partial_refunded',
    },
  ];

  for (const check of statusChecks) {
    const query = supabase
      .from('payment_orders')
      .select('id')
      .eq('stripe_subscription_id', subscriptionId)
      .eq(check.column, check.value);
    const result = await (invoiceId
      ? query.eq('stripe_invoice_id', invoiceId)
      : query
    ).limit(1);

    if (result.error) {
      throwGrantError(
        check.stage,
        SUBSCRIPTION_GRANT_ERRORS.refundLookup,
        result.error,
        { subscriptionId: maskIdentifier(subscriptionId), invoiceId: maskIdentifier(invoiceId) },
      );
    }

    if ((result.data ?? []).length > 0) {
      return true;
    }
  }

  const metadataChecks = [
    {
      stage: 'subscription_full_refund_reconciliation_marker_lookup',
      marker: {
        stripeRefundReconciliation: {
          fullRefund: true,
          ...(invoiceId ? { invoiceId } : {}),
        },
      },
    },
    {
      stage: 'subscription_full_refund_grant_reversal_marker_lookup',
      marker: {
        subscriptionCreditGrantReversal: {
          fullRefund: true,
          ...(invoiceId ? { invoiceId } : {}),
        },
      },
    },
  ];

  for (const check of metadataChecks) {
    const result = await supabase
      .from('payment_orders')
      .select('id')
      .eq('stripe_subscription_id', subscriptionId)
      .contains('metadata', check.marker)
      .limit(1);

    if (result.error) {
      throwGrantError(
        check.stage,
        SUBSCRIPTION_GRANT_ERRORS.refundLookup,
        result.error,
        { subscriptionId: maskIdentifier(subscriptionId), invoiceId: maskIdentifier(invoiceId) },
      );
    }

    if ((result.data ?? []).length > 0) {
      return true;
    }
  }

  return false;
}

function getAnnualReleaseInvoiceId(subscription: SubscriptionRow) {
  const invoiceId = subscription.metadata?.lastInvoiceId;
  return typeof invoiceId === 'string' && invoiceId.trim()
    ? invoiceId.trim()
    : null;
}

function buildSubscriptionRefundIdempotencyKey(
  input: ReconcileSubscriptionRefundCreditGrantsInput,
  scope: { invoiceId?: string | null } = {},
) {
  if (input.isFullRefund) {
    const invoiceToken = scope.invoiceId?.trim() || input.invoiceId?.trim() || null;
    const fullRefundToken = invoiceToken
      ? `invoice:${invoiceToken}`
      : `order:${input.orderId}`;
    return `stripe_refund:subscription_grants:${fullRefundToken}:${input.subscriptionId}`;
  }

  const refundToken = input.refundId?.trim() || input.orderId;
  return `stripe_refund:subscription_grants:${refundToken}:${input.subscriptionId}`;
}

function buildLegacySubscriptionRefundIdempotencyKey(
  input: ReconcileSubscriptionRefundCreditGrantsInput,
) {
  if (!input.isFullRefund) {
    return null;
  }

  const refundToken = input.refundId?.trim();
  if (!refundToken) {
    return null;
  }

  return `stripe_refund:subscription_grants:${refundToken}:${input.subscriptionId}`;
}

function getRefundClawbackDescription(input: {
  subscriptionId: string;
  refundId?: string | null;
  reversedGrantCount: number;
}) {
  return `Stripe subscription refund credit clawback [subscription:${input.subscriptionId} refund:${input.refundId ?? 'unknown'} grants:${input.reversedGrantCount}]`;
}

function toNonNegativeInteger(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  return 0;
}

function getTransactionAmount(value: CreditTransactionRow | null | undefined) {
  if (!value) return 0;
  if (typeof value.amount === 'number') return Math.abs(value.amount);
  if (typeof value.amount === 'string') {
    const parsed = Number(value.amount);
    return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  }
  return 0;
}

function buildSubscriptionRefundMetadata(input: {
  existingMetadata?: Record<string, unknown> | null;
  refund: ReconcileSubscriptionRefundCreditGrantsInput;
  now: string;
  idempotencyKey: string;
  reviewRequired: boolean;
  reviewReason?: string | null;
  clawbackAmount?: number;
  appliedClawbackAmount?: number;
  shortfallAmount?: number;
  shortfallReason?: string | null;
  reversalStatus?: string;
  reversedGrantCount?: number;
  creditTransactionId?: string | null;
  alreadyReconciled?: boolean;
  terminationWritten?: boolean;
  terminatedAt?: string | null;
  terminationReason?: string | null;
  terminationEventId?: string | null;
  locatedPeriodKey?: string | null;
  consumedAtReversal?: number | null;
  alreadyReversed?: boolean;
}) {
  return {
    ...asRecord(input.existingMetadata),
    subscriptionCreditGrantReversal: {
      refundId: input.refund.refundId ?? null,
      eventType: input.refund.refundEventType ?? null,
      refundStatus: input.refund.refundStatus ?? null,
      subscriptionId: input.refund.subscriptionId,
      invoiceId: input.refund.invoiceId ?? null,
      amountRefunded: input.refund.refundAmount ?? null,
      currency: input.refund.refundCurrency ?? null,
      fullRefund: input.refund.isFullRefund,
      reviewRequired: input.reviewRequired,
      reviewReason: input.reviewReason ?? null,
      clawbackAmount: input.clawbackAmount ?? 0,
      appliedClawbackAmount: input.appliedClawbackAmount ?? input.clawbackAmount ?? 0,
      shortfallAmount: input.shortfallAmount ?? 0,
      shortfallReason: input.shortfallReason ?? null,
      reversedGrantCount: input.reversedGrantCount ?? 0,
      creditTransactionId: input.creditTransactionId ?? null,
      alreadyReconciled: input.alreadyReconciled ?? false,
      idempotencyKey: input.idempotencyKey,
      reversalStatus: input.reversalStatus ?? (input.reviewRequired ? 'review_required' : 'complete'),
      reconciledAt: input.now,
      source: 'subscription_credit_grants_refund_reconciliation',
      termination: {
        written: input.terminationWritten ?? false,
        terminatedAt: input.terminatedAt ?? null,
        reason: input.terminationReason ?? null,
        eventId: input.terminationEventId ?? null,
      },
      locatedPeriodKey: input.locatedPeriodKey ?? null,
      consumedAtReversal: input.consumedAtReversal ?? null,
      alreadyReversed: input.alreadyReversed ?? false,
    },
  };
}

/**
 * REFUND-1B: 由可信退款时间戳定位退款发生的周期 (start <= t < end)。
 * 缺可信时间戳 / 无窗口覆盖 → REVIEW_REQUIRED (不猜测)。
 */
function locateRefundPeriodGrant(input: {
  grants: SubscriptionCreditGrantRow[];
  refundCreatedAt?: string | null;
}): { grant: SubscriptionCreditGrantRow | null; reviewReason: string | null } {
  const refundMs = parseTime(input.refundCreatedAt ?? null);
  if (refundMs === null) {
    return { grant: null, reviewReason: 'missing_trusted_refund_timestamp' };
  }

  const candidates = input.grants
    .filter((grant) => {
      const startMs = parseTime(grant.period_start);
      const endMs = parseTime(grant.period_end);
      return startMs !== null && endMs !== null && startMs <= refundMs && refundMs < endMs;
    })
    .sort((left, right) => {
      const leftStart = parseTime(left.period_start) ?? 0;
      const rightStart = parseTime(right.period_start) ?? 0;
      if (leftStart !== rightStart) {
        return rightStart - leftStart;
      }
      return (parseTime(right.created_at) ?? 0) - (parseTime(left.created_at) ?? 0);
    });

  if (candidates.length === 0) {
    return { grant: null, reviewReason: 'no_period_window_covers_refund_timestamp' };
  }

  return { grant: candidates[0], reviewReason: null };
}

/**
 * REFUND-1B: 先写 termination（release cron 立即停发）。
 * 守卫写入：首个成功事件确立 termination；已存在 → written=false。
 */
async function writeCreditReleaseTermination(input: {
  supabase: SupabaseLikeClient;
  subscriptionId: string;
  now: string;
  reason: string;
  eventId: string | null;
  periodKey: string | null;
}): Promise<{
  written: boolean;
  mirrorMissing: boolean;
  existing: {
    terminatedAt: string | null;
    reason: string | null;
    eventId: string | null;
    periodKey: string | null;
  } | null;
}> {
  const writeResult = await input.supabase
    .from('user_subscriptions')
    .update({
      credit_release_terminated_at: input.now,
      credit_release_terminated_reason: input.reason,
      credit_release_terminated_event_id: input.eventId,
      credit_release_terminated_period_key: input.periodKey,
      updated_at: input.now,
    })
    .eq('stripe_subscription_id', input.subscriptionId)
    .is('credit_release_terminated_at', null)
    .select('id, credit_release_terminated_at')
    .maybeSingle();

  if (writeResult.error) {
    throwGrantError(
      'subscription_credit_release_termination_write',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
      writeResult.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  if (writeResult.data?.id) {
    return {
      written: true,
      mirrorMissing: false,
      existing: {
        terminatedAt: input.now,
        reason: input.reason,
        eventId: input.eventId,
        periodKey: input.periodKey,
      },
    };
  }

  const readResult = await input.supabase
    .from('user_subscriptions')
    .select('id, credit_release_terminated_at, credit_release_terminated_reason, credit_release_terminated_event_id, credit_release_terminated_period_key')
    .eq('stripe_subscription_id', input.subscriptionId)
    .limit(1);

  if (readResult.error) {
    throwGrantError(
      'subscription_credit_release_termination_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
      readResult.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  const row = asSubscriptionRows(readResult.data as SubscriptionRow | SubscriptionRow[] | null)[0] ?? null;
  if (!row?.id) {
    return { written: false, mirrorMissing: true, existing: null };
  }

  return {
    written: false,
    mirrorMissing: false,
    existing: {
      terminatedAt: row.credit_release_terminated_at ?? null,
      reason: row.credit_release_terminated_reason ?? null,
      eventId: row.credit_release_terminated_event_id ?? null,
      periodKey: row.credit_release_terminated_period_key ?? null,
    },
  };
}

async function getSubscriptionRefundOrder(
  supabase: SupabaseLikeClient,
  input: ReconcileSubscriptionRefundCreditGrantsInput,
): Promise<PaymentOrderRow> {
  const result = await supabase
    .from('payment_orders')
    .select('id, user_id, status, payment_status, stripe_invoice_id, stripe_subscription_id, metadata')
    .eq('id', input.orderId)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_refund_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.refundOrderLookup,
      result.error,
      { orderId: maskIdentifier(input.orderId), subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  if (!result.data?.id) {
    throwGrantError(
      'subscription_refund_order_missing',
      SUBSCRIPTION_GRANT_ERRORS.refundOrderLookup,
      new Error('subscription refund order missing'),
      { orderId: maskIdentifier(input.orderId), subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  if (result.data.stripe_subscription_id && result.data.stripe_subscription_id !== input.subscriptionId) {
    throwGrantError(
      'subscription_refund_order_subscription_mismatch',
      SUBSCRIPTION_GRANT_ERRORS.refundOrderLookup,
      new Error('subscription refund order does not match subscription id'),
      { orderId: maskIdentifier(input.orderId), subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  return result.data;
}

async function updateSubscriptionRefundOrder(input: {
  supabase: SupabaseLikeClient;
  order: PaymentOrderRow;
  refund: ReconcileSubscriptionRefundCreditGrantsInput;
  now: string;
  idempotencyKey: string;
  reviewRequired: boolean;
  reviewReason?: string | null;
  clawbackAmount?: number;
  appliedClawbackAmount?: number;
  shortfallAmount?: number;
  shortfallReason?: string | null;
  reversalStatus?: string;
  reversedGrantCount?: number;
  creditTransactionId?: string | null;
  alreadyReconciled?: boolean;
  terminationWritten?: boolean;
  terminatedAt?: string | null;
  terminationReason?: string | null;
  terminationEventId?: string | null;
  locatedPeriodKey?: string | null;
  consumedAtReversal?: number | null;
  alreadyReversed?: boolean;
  orderStatus?: string;
  paymentStatus?: string;
}) {
  const status = input.orderStatus ?? (input.refund.isFullRefund ? 'refunded' : 'partially_refunded');
  const result = await input.supabase
    .from('payment_orders')
    .update({
      status,
      payment_status: input.paymentStatus ?? status,
      updated_at: input.now,
      metadata: buildSubscriptionRefundMetadata({
        existingMetadata: input.order.metadata,
        refund: input.refund,
        now: input.now,
        idempotencyKey: input.idempotencyKey,
        reviewRequired: input.reviewRequired,
        reviewReason: input.reviewReason,
        clawbackAmount: input.clawbackAmount,
        appliedClawbackAmount: input.appliedClawbackAmount,
        shortfallAmount: input.shortfallAmount,
        shortfallReason: input.shortfallReason,
        reversalStatus: input.reversalStatus,
        reversedGrantCount: input.reversedGrantCount,
        creditTransactionId: input.creditTransactionId,
        alreadyReconciled: input.alreadyReconciled,
        terminationWritten: input.terminationWritten,
        terminatedAt: input.terminatedAt,
        terminationReason: input.terminationReason,
        terminationEventId: input.terminationEventId,
        locatedPeriodKey: input.locatedPeriodKey,
        consumedAtReversal: input.consumedAtReversal,
        alreadyReversed: input.alreadyReversed,
      }),
    })
    .eq('id', input.order.id);

  if (result.error) {
    throwGrantError(
      'subscription_refund_order_update',
      SUBSCRIPTION_GRANT_ERRORS.refundOrderWrite,
      result.error,
      { orderId: maskIdentifier(input.order.id), subscriptionId: maskIdentifier(input.refund.subscriptionId) },
    );
  }
}

async function getProfileCreditBalance(
  supabase: SupabaseLikeClient,
  userId: string,
): Promise<number | null> {
  const result = await supabase
    .from('profiles')
    .select('id, credits')
    .eq('id', userId)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_refund_profile_credit_lookup',
      SUBSCRIPTION_GRANT_ERRORS.refundCreditTransactionLookup,
      result.error,
      { userId: maskIdentifier(userId) },
    );
  }

  const row = result.data as ProfileCreditRow | null;
  if (!row?.id) {
    return null;
  }

  return toNonNegativeInteger(row.credits);
}

async function getExistingRefundClawbackTransaction(
  supabase: SupabaseLikeClient,
  input: { userId: string; idempotencyKey: string },
): Promise<CreditTransactionRow | null> {
  const result = await supabase
    .from('credit_transactions')
    .select('id, amount')
    .eq('user_id', input.userId)
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_refund_clawback_lookup',
      SUBSCRIPTION_GRANT_ERRORS.refundCreditTransactionLookup,
      result.error,
      { userId: maskIdentifier(input.userId), idempotencyKey: input.idempotencyKey },
    );
  }

  return result.data ?? null;
}

async function getExistingRefundClawbackTransactionForKeys(
  supabase: SupabaseLikeClient,
  input: { userId: string; idempotencyKeys: string[] },
): Promise<{ transaction: CreditTransactionRow | null; idempotencyKey: string | null }> {
  const uniqueKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];

  for (const idempotencyKey of uniqueKeys) {
    const transaction = await getExistingRefundClawbackTransaction(supabase, {
      userId: input.userId,
      idempotencyKey,
    });

    if (transaction?.id) {
      return { transaction, idempotencyKey };
    }
  }

  return { transaction: null, idempotencyKey: null };
}

async function loadAllSubscriptionCreditGrants(
  supabase: SupabaseLikeClient,
  input: { subscriptionId: string },
): Promise<SubscriptionCreditGrantRow[]> {
  const result = await supabase
    .from('subscription_credit_grants')
    .select('id, user_id, membership_plan_id, stripe_subscription_id, stripe_invoice_id, billing_cycle, grant_type, grant_period_key, period_start, period_end, period_index, credits_granted, consumed_amount, status, credit_transaction_id, metadata, created_at')
    .eq('stripe_subscription_id', input.subscriptionId);

  if (result.error) {
    throwGrantError(
      'subscription_refund_credit_grant_lookup',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
      result.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  return result.data ?? [];
}

function getRefundInvoiceScope(order: PaymentOrderRow, input: ReconcileSubscriptionRefundCreditGrantsInput) {
  const inputInvoiceId = input.invoiceId?.trim() || null;
  const orderInvoiceId = order.stripe_invoice_id?.trim() || null;

  if (inputInvoiceId && orderInvoiceId && inputInvoiceId !== orderInvoiceId) {
    return {
      invoiceId: null,
      status: 'invoice_scope_mismatch_review_required',
      reason: 'invoice_scope_mismatch',
    };
  }

  if (!inputInvoiceId && !orderInvoiceId) {
    return {
      invoiceId: null,
      status: 'invoice_scope_missing_review_required',
      reason: 'invoice_scope_missing',
    };
  }

  return {
    invoiceId: inputInvoiceId ?? orderInvoiceId,
    status: 'scoped',
    reason: null,
  };
}

function collectSubscriptionRefundIdempotencyKeys(input: {
  order: PaymentOrderRow;
  grants: SubscriptionCreditGrantRow[];
  idempotencyKey: string;
  legacyIdempotencyKey?: string | null;
  existingReversalIdempotencyKey?: string | null;
}) {
  const idempotencyKeys = [
    input.idempotencyKey,
    input.legacyIdempotencyKey,
    input.existingReversalIdempotencyKey,
  ];
  const orderReversalKey = asRecord(
    asRecord(input.order.metadata).subscriptionCreditGrantReversal,
  ).idempotencyKey;

  if (typeof orderReversalKey === 'string' && orderReversalKey.trim()) {
    idempotencyKeys.push(orderReversalKey.trim());
  }

  input.grants.forEach((grant) => {
    const reversalKey = asRecord(asRecord(grant.metadata).reversal).idempotencyKey;
    if (typeof reversalKey === 'string' && reversalKey.trim()) {
      idempotencyKeys.push(reversalKey.trim());
    }
  });

  return [...new Set(idempotencyKeys.filter((value): value is string => Boolean(value)))];
}

async function applySubscriptionRefundClawback(input: {
  supabase: SupabaseLikeClient;
  userId: string;
  amount: number;
  refund: ReconcileSubscriptionRefundCreditGrantsInput;
  idempotencyKey: string;
  reversedGrantCount: number;
}) {
  const result = await input.supabase.rpc('atomic_apply_credit_ledger_entry', {
    p_user_id: input.userId,
    p_amount: -input.amount,
    p_type: 'deduction',
    p_description: getRefundClawbackDescription({
      subscriptionId: input.refund.subscriptionId,
      refundId: input.refund.refundId,
      reversedGrantCount: input.reversedGrantCount,
    }),
    p_idempotency_key: input.idempotencyKey,
  });

  if (result.error) {
    throwGrantError(
      'subscription_refund_clawback_rpc',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantRpc,
      result.error,
      { userId: maskIdentifier(input.userId), subscriptionId: maskIdentifier(input.refund.subscriptionId) },
    );
  }

  const row = getFirstRpcRow<{ transaction_id?: string | null; amount?: number | null }>(result.data);
  if (!row?.transaction_id) {
    throwGrantError(
      'subscription_refund_clawback_rpc_result',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantRpc,
      new Error('refund clawback RPC returned no transaction id'),
      { userId: maskIdentifier(input.userId), subscriptionId: maskIdentifier(input.refund.subscriptionId) },
    );
  }

  return row.transaction_id;
}

async function updateRefundClawbackTransactionSemantics(input: {
  supabase: SupabaseLikeClient;
  transactionId: string;
  refund: ReconcileSubscriptionRefundCreditGrantsInput;
  idempotencyKey: string;
  amount: number;
  requiredAmount: number;
  shortfallAmount: number;
  reversedGrantCount: number;
  reversedGrantPeriodKeys: string[];
}) {
  const result = await input.supabase
    .from('credit_transactions')
    .update({
      ledger_type: 'refund_clawback',
      reason_code: 'refund_clawback',
      counts_as_spend: false,
      source_type: 'stripe_refund',
      source_id: input.refund.refundId ?? input.refund.subscriptionId,
      source_order_id: input.refund.orderId,
      source_refund_id: input.refund.refundId ?? null,
      metadata: {
        subscriptionId: input.refund.subscriptionId,
        invoiceId: input.refund.invoiceId ?? null,
        refundId: input.refund.refundId ?? null,
        refundStatus: input.refund.refundStatus ?? null,
        refundEventType: input.refund.refundEventType ?? null,
        clawbackAmount: input.amount,
        requiredClawbackAmount: input.requiredAmount,
        shortfallAmount: input.shortfallAmount,
        reversedGrantCount: input.reversedGrantCount,
        reversedGrantPeriodKeys: input.reversedGrantPeriodKeys,
        idempotencyKey: input.idempotencyKey,
      },
    })
    .eq('id', input.transactionId)
    .select('id')
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_refund_clawback_semantics_update',
      SUBSCRIPTION_GRANT_ERRORS.refundCreditTransactionUpdate,
      result.error,
      { transactionId: maskIdentifier(input.transactionId), subscriptionId: maskIdentifier(input.refund.subscriptionId) },
    );
  }
}

export async function reconcileSubscriptionRefundCreditGrants(
  supabase: SupabaseLikeClient,
  input: ReconcileSubscriptionRefundCreditGrantsInput,
): Promise<SubscriptionRefundCreditGrantReconciliationResult> {
  const now = input.now ?? new Date().toISOString();
  const order = await getSubscriptionRefundOrder(supabase, input);
  const invoiceScope = getRefundInvoiceScope(order, input);
  const scopedRefund = invoiceScope.invoiceId && invoiceScope.invoiceId !== input.invoiceId
    ? { ...input, invoiceId: invoiceScope.invoiceId }
    : input;
  const idempotencyKey = buildSubscriptionRefundIdempotencyKey(scopedRefund, {
    invoiceId: invoiceScope.invoiceId,
  });

  const priorReversal = asRecord(asRecord(order.metadata).subscriptionCreditGrantReversal);
  const priorReversalStatus = typeof priorReversal.reversalStatus === 'string'
    ? priorReversal.reversalStatus
    : null;
  const priorTermination = asRecord(priorReversal.termination);

  // 已完成的 reconciliation: 重放/后续事件不重复扣、不追历史
  if (priorReversalStatus && priorReversalStatus !== 'pending') {
    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: input.isFullRefund,
      reviewRequired: priorReversal.reviewRequired === true,
      reviewReason: typeof priorReversal.reviewReason === 'string'
        ? priorReversal.reviewReason
        : null,
      terminationWritten: false,
      terminatedAt: typeof priorTermination.terminatedAt === 'string'
        ? priorTermination.terminatedAt
        : null,
      locatedPeriodKey: typeof priorReversal.locatedPeriodKey === 'string'
        ? priorReversal.locatedPeriodKey
        : null,
      reversedGrantCount: toNonNegativeInteger(priorReversal.reversedGrantCount),
      clawbackAmount: toNonNegativeInteger(priorReversal.clawbackAmount),
      appliedClawbackAmount: toNonNegativeInteger(
        priorReversal.appliedClawbackAmount ?? priorReversal.clawbackAmount,
      ),
      shortfallAmount: toNonNegativeInteger(priorReversal.shortfallAmount),
      creditTransactionId: typeof priorReversal.creditTransactionId === 'string'
        ? priorReversal.creditTransactionId
        : null,
      alreadyReconciled: true,
    };
  }

  // 标记 pending (崩溃恢复锚点)
  await updateSubscriptionRefundOrder({
    supabase,
    order,
    refund: scopedRefund,
    now,
    idempotencyKey,
    reviewRequired: false,
    reversalStatus: 'pending',
  });

  // REFUND-1B: 可信退款时间戳定位周期 (start <= t < end)，缺证据即 REVIEW_REQUIRED
  const grants = await loadAllSubscriptionCreditGrants(supabase, {
    subscriptionId: input.subscriptionId,
  });
  const located = locateRefundPeriodGrant({
    grants,
    refundCreatedAt: input.refundCreatedAt,
  });
  const locatedPeriodKey = located.grant?.grant_period_key ?? null;

  let reviewReason: string | null = located.reviewReason;
  if (invoiceScope.status !== 'scoped') {
    reviewReason ??= invoiceScope.reason;
  }

  // REFUND-1B: 先写 termination (release cron 立即停发，即使 REVIEW_REQUIRED)
  const terminationReason = `stripe_refund:${input.refundEventType ?? 'refund'}`;
  const terminationEventId = input.eventId ?? input.refundId ?? null;
  const termination = await writeCreditReleaseTermination({
    supabase,
    subscriptionId: input.subscriptionId,
    now,
    reason: terminationReason,
    eventId: terminationEventId,
    periodKey: locatedPeriodKey,
  });
  const terminatedAt = termination.written
    ? now
    : termination.existing?.terminatedAt ?? null;

  // termination 已被更早成功事件确立且无需恢复 → 本次事件不再扣
  if (!termination.written && !termination.mirrorMissing && priorReversalStatus !== 'pending') {
    await updateSubscriptionRefundOrder({
      supabase,
      order,
      refund: scopedRefund,
      now,
      idempotencyKey,
      reviewRequired: false,
      reversalStatus: 'complete',
      terminationWritten: false,
      terminatedAt,
      terminationReason: termination.existing?.reason ?? null,
      terminationEventId: termination.existing?.eventId ?? null,
      locatedPeriodKey,
      alreadyReconciled: true,
    });

    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: input.isFullRefund,
      reviewRequired: false,
      reviewReason: null,
      terminationWritten: false,
      terminatedAt,
      locatedPeriodKey,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
      alreadyReconciled: true,
    };
  }

  // REVIEW_REQUIRED: 不自动扣、不猜测 (termination 已写，未来释放已停止)
  if (reviewReason) {
    await updateSubscriptionRefundOrder({
      supabase,
      order,
      refund: scopedRefund,
      now,
      idempotencyKey,
      reviewRequired: true,
      reviewReason,
      reversalStatus: 'review_required',
      terminationWritten: termination.written,
      terminatedAt,
      terminationReason: termination.written ? terminationReason : termination.existing?.reason ?? null,
      terminationEventId: termination.written ? terminationEventId : termination.existing?.eventId ?? null,
      locatedPeriodKey,
    });

    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: input.isFullRefund,
      reviewRequired: true,
      reviewReason,
      terminationWritten: termination.written,
      terminatedAt,
      locatedPeriodKey,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
      alreadyReconciled: false,
    };
  }

  // 守卫反转定位周期 grant: clawback = credits_granted - consumed_amount (反转时原子读取)
  const locatedGrant = located.grant as SubscriptionCreditGrantRow & { id: string };
  const userId = order.user_id ?? locatedGrant.user_id ?? null;
  let clawbackAmount = 0;
  let consumedAtReversal: number | null = null;
  let alreadyReversed = false;

  const reversalResult = await supabase
    .from('subscription_credit_grants')
    .update({
      status: 'reversed',
      updated_at: now,
      metadata: {
        ...asRecord(locatedGrant.metadata),
        reversal: {
          refundId: input.refundId ?? null,
          subscriptionId: input.subscriptionId,
          invoiceId: input.invoiceId ?? null,
          periodKey: locatedPeriodKey,
          idempotencyKey,
          reversedAt: now,
          source: 'subscription_refund',
        },
      },
    })
    .eq('id', locatedGrant.id)
    .eq('status', 'granted')
    .select('id, credits_granted, consumed_amount')
    .maybeSingle();

  if (reversalResult.error) {
    throwGrantError(
      'subscription_refund_credit_grant_reversal',
      SUBSCRIPTION_GRANT_ERRORS.refundCreditGrantReversal,
      reversalResult.error,
      { grantId: maskIdentifier(locatedGrant.id), subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  if (reversalResult.data?.id) {
    consumedAtReversal = toNonNegativeInteger(reversalResult.data.consumed_amount);
    clawbackAmount = Math.max(
      0,
      toNonNegativeInteger(reversalResult.data.credits_granted) - consumedAtReversal,
    );
  } else {
    const reread = await supabase
      .from('subscription_credit_grants')
      .select('id, status, credits_granted, consumed_amount, metadata')
      .eq('id', locatedGrant.id)
      .maybeSingle();

    if (reread.error) {
      throwGrantError(
        'subscription_refund_credit_grant_reread',
        SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
        reread.error,
        { grantId: maskIdentifier(locatedGrant.id), subscriptionId: maskIdentifier(input.subscriptionId) },
      );
    }

    alreadyReversed = reread.data?.status === 'reversed';
    if (alreadyReversed) {
      // 恢复路径: 已被先前尝试反转 → 采用先前记录的 clawback 金额，不重复扣
      const priorGrantReversal = asRecord(asRecord(reread.data?.metadata).reversal);
      const priorGrantClawback = toNonNegativeInteger(priorGrantReversal.clawbackAmount);
      const priorGrantGranted = toNonNegativeInteger(reread.data?.credits_granted);
      const priorGrantConsumed = toNonNegativeInteger(reread.data?.consumed_amount);
      clawbackAmount = priorGrantClawback > 0
        ? priorGrantClawback
        : Math.max(0, priorGrantGranted - priorGrantConsumed);
    }
  }

  const reversedGrantCount = alreadyReversed ? 0 : 1;
  let creditTransactionId: string | null = null;
  let alreadyReconciled = false;
  let appliedClawbackAmount = 0;
  let shortfallAmount = clawbackAmount;
  let shortfallReason: string | null = clawbackAmount > 0 ? 'clawback_not_applied' : null;

  if (userId) {
    const legacyIdempotencyKey = buildLegacySubscriptionRefundIdempotencyKey(scopedRefund);
    const existingReversalIdempotencyKey = typeof priorReversal.idempotencyKey === 'string'
      ? priorReversal.idempotencyKey.trim()
      : null;
    const existingShortfallReason = typeof priorReversal.shortfallReason === 'string'
      ? priorReversal.shortfallReason
      : null;
    const refundIdempotencyKeys = collectSubscriptionRefundIdempotencyKeys({
      order,
      grants: [locatedGrant],
      idempotencyKey,
      legacyIdempotencyKey,
      existingReversalIdempotencyKey,
    });
    const existingTransactionResult = await getExistingRefundClawbackTransactionForKeys(supabase, {
      userId,
      idempotencyKeys: refundIdempotencyKeys,
    });
    const existingTransaction = existingTransactionResult.transaction;

    if (existingTransaction?.id) {
      creditTransactionId = existingTransaction.id;
      alreadyReconciled = true;
      appliedClawbackAmount = getTransactionAmount(existingTransaction);
      shortfallAmount = Math.max(clawbackAmount - appliedClawbackAmount, 0);
      shortfallReason = shortfallAmount > 0
        ? existingShortfallReason ?? 'existing_clawback_shortfall'
        : null;
      if (
        appliedClawbackAmount > 0
        && existingTransactionResult.idempotencyKey === idempotencyKey
      ) {
        await updateRefundClawbackTransactionSemantics({
          supabase,
          transactionId: creditTransactionId,
          refund: scopedRefund,
          idempotencyKey,
          amount: appliedClawbackAmount,
          requiredAmount: clawbackAmount,
          shortfallAmount,
          reversedGrantCount,
          reversedGrantPeriodKeys: locatedPeriodKey ? [locatedPeriodKey] : [],
        });
      }
    } else if (clawbackAmount > 0) {
      const currentBalance = await getProfileCreditBalance(supabase, userId);
      appliedClawbackAmount = Math.min(clawbackAmount, currentBalance ?? 0);
      shortfallAmount = clawbackAmount - appliedClawbackAmount;
      shortfallReason = currentBalance === null
        ? 'profile_missing'
        : shortfallAmount > 0
          ? 'insufficient_balance'
          : null;

      if (appliedClawbackAmount > 0) {
        creditTransactionId = await applySubscriptionRefundClawback({
          supabase,
          userId,
          amount: appliedClawbackAmount,
          refund: scopedRefund,
          idempotencyKey,
          reversedGrantCount,
        });
        await updateRefundClawbackTransactionSemantics({
          supabase,
          transactionId: creditTransactionId,
          refund: scopedRefund,
          idempotencyKey,
          amount: appliedClawbackAmount,
          requiredAmount: clawbackAmount,
          shortfallAmount,
          reversedGrantCount,
          reversedGrantPeriodKeys: locatedPeriodKey ? [locatedPeriodKey] : [],
        });
      }
    }
  } else if (clawbackAmount > 0) {
    shortfallReason = 'user_missing';
  } else {
    shortfallAmount = 0;
    shortfallReason = null;
  }

  const reviewRequired = shortfallAmount > 0;

  await updateSubscriptionRefundOrder({
    supabase,
    order,
    refund: scopedRefund,
    now,
    idempotencyKey,
    reviewRequired,
    clawbackAmount,
    appliedClawbackAmount,
    shortfallAmount,
    shortfallReason,
    reversalStatus: reviewRequired ? 'shortfall_review_required' : 'complete',
    reversedGrantCount,
    creditTransactionId,
    alreadyReconciled,
    terminationWritten: termination.written,
    terminatedAt,
    terminationReason: termination.written ? terminationReason : termination.existing?.reason ?? null,
    terminationEventId: termination.written ? terminationEventId : termination.existing?.eventId ?? null,
    locatedPeriodKey,
    consumedAtReversal,
    alreadyReversed,
  });

  return {
    orderId: order.id as string,
    subscriptionId: input.subscriptionId,
    refundId: input.refundId ?? null,
    fullRefund: input.isFullRefund,
    reviewRequired,
    reviewReason: null,
    terminationWritten: termination.written,
    terminatedAt,
    locatedPeriodKey,
    reversedGrantCount,
    clawbackAmount,
    appliedClawbackAmount,
    shortfallAmount,
    creditTransactionId,
    alreadyReconciled,
  };
}

async function getExistingCreditGrant(
  supabase: SupabaseLikeClient,
  idempotencyKey: string,
) {
  const result = await supabase
    .from('subscription_credit_grants')
    .select('id, credit_transaction_id, credits_granted, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_credit_grant_lookup',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
      result.error,
      { idempotencyKey },
    );
  }

  return result.data ?? null;
}

async function applyCreditLedgerGrant(
  supabase: SupabaseLikeClient,
  input: GrantSubscriptionCreditsInput & { idempotencyKey: string },
) {
  const description = getGrantDescription(input);
  const result = await supabase.rpc('atomic_apply_credit_ledger_entry', {
    p_user_id: input.userId,
    p_amount: input.creditsGranted,
    p_type: 'addition',
    p_description: description,
    p_idempotency_key: input.idempotencyKey,
  });

  if (result.error) {
    throwGrantError(
      'subscription_credit_grant_rpc',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantRpc,
      result.error,
      {
        userId: maskIdentifier(input.userId),
        subscriptionId: maskIdentifier(input.stripeSubscriptionId),
        grantPeriodKey: input.grantPeriodKey,
      },
    );
  }

  const row = getFirstRpcRow<{
    transaction_id?: string | null;
    is_idempotent?: boolean | null;
  }>(result.data);
  if (!row?.transaction_id) {
    throwGrantError(
      'subscription_credit_grant_rpc_result',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantRpc,
      new Error('credit grant RPC returned no transaction id'),
      {
        userId: maskIdentifier(input.userId),
        subscriptionId: maskIdentifier(input.stripeSubscriptionId),
        grantPeriodKey: input.grantPeriodKey,
      },
    );
  }

  return row;
}

async function updateCreditTransactionSemantics(
  supabase: SupabaseLikeClient,
  input: GrantSubscriptionCreditsInput & {
    idempotencyKey: string;
    creditTransactionId: string;
  },
) {
  const result = await supabase
    .from('credit_transactions')
    .update({
      ledger_type: 'grant',
      reason_code: getGrantReasonCode(input.grantType),
      counts_as_spend: false,
      source_type: input.sourceType,
      source_id: input.sourceId ?? input.stripeInvoiceId ?? input.stripeSubscriptionId,
      source_order_id: input.sourceOrderId ?? null,
      grant_period_key: input.grantPeriodKey,
      metadata: {
        subscriptionId: input.stripeSubscriptionId,
        invoiceId: input.stripeInvoiceId ?? null,
        grantType: input.grantType,
        billingCycle: input.billingCycle,
        periodIndex: input.periodIndex,
        totalPeriods: input.totalPeriods,
        idempotencyKey: input.idempotencyKey,
      },
    })
    .eq('id', input.creditTransactionId)
    .select('id')
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_credit_transaction_update',
      SUBSCRIPTION_GRANT_ERRORS.creditTransactionUpdate,
      result.error,
      {
        transactionId: maskIdentifier(input.creditTransactionId),
        grantPeriodKey: input.grantPeriodKey,
      },
    );
  }
}

async function insertSubscriptionCreditGrant(
  supabase: SupabaseLikeClient,
  input: GrantSubscriptionCreditsInput & {
    idempotencyKey: string;
    creditTransactionId: string;
  },
) {
  const result = await supabase
    .from('subscription_credit_grants')
    .insert({
      user_id: input.userId,
      membership_plan_id: input.membershipPlanId,
      stripe_subscription_id: input.stripeSubscriptionId,
      stripe_invoice_id: input.stripeInvoiceId ?? null,
      billing_cycle: input.billingCycle,
      grant_type: input.grantType,
      grant_period_key: input.grantPeriodKey,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      period_index: input.periodIndex,
      total_periods: input.totalPeriods,
      credits_granted: input.creditsGranted,
      status: 'granted',
      idempotency_key: input.idempotencyKey,
      credit_transaction_id: input.creditTransactionId,
      metadata: {
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? input.stripeInvoiceId ?? input.stripeSubscriptionId,
      },
    })
    .select('id, credit_transaction_id, credits_granted, status')
    .maybeSingle();

  if (result.error) {
    if (result.error.code === '23505') {
      return getExistingCreditGrant(supabase, input.idempotencyKey);
    }

    throwGrantError(
      'subscription_credit_grant_insert',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantInsert,
      result.error,
      {
        userId: maskIdentifier(input.userId),
        subscriptionId: maskIdentifier(input.stripeSubscriptionId),
        grantPeriodKey: input.grantPeriodKey,
      },
    );
  }

  return result.data;
}

export async function grantSubscriptionCredits(
  supabase: SupabaseLikeClient,
  input: GrantSubscriptionCreditsInput,
) {
  if (input.creditsGranted <= 0) {
    return {
      granted: false,
      creditsGranted: 0,
      creditTransactionId: null,
      idempotencyKey: buildGrantIdempotencyKey(input),
      grantId: null,
    };
  }

  const idempotencyKey = buildGrantIdempotencyKey(input);
  const existingGrant = await getExistingCreditGrant(supabase, idempotencyKey);
  if (existingGrant) {
    return {
      granted: false,
      creditsGranted: existingGrant.credits_granted ?? 0,
      creditTransactionId: existingGrant.credit_transaction_id ?? null,
      idempotencyKey,
      grantId: existingGrant.id ?? null,
    };
  }

  const ledgerEntry = await applyCreditLedgerGrant(supabase, {
    ...input,
    idempotencyKey,
  });
  const creditTransactionId = ledgerEntry.transaction_id as string;

  await updateCreditTransactionSemantics(supabase, {
    ...input,
    idempotencyKey,
    creditTransactionId,
  });

  const insertedGrant = await insertSubscriptionCreditGrant(supabase, {
    ...input,
    idempotencyKey,
    creditTransactionId,
  });

  return {
    granted: true,
    creditsGranted: input.creditsGranted,
    creditTransactionId,
    idempotencyKey,
    grantId: insertedGrant?.id ?? null,
  };
}

async function upsertSubscriptionMirror(input: {
  supabase: SupabaseLikeClient;
  sourceOrder: PaymentOrderRow;
  plan: MembershipPlanRow;
  subscriptionId: string;
  stripeCustomerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  billingCycle: SubscriptionBillingCycle;
  transactionId?: string | null;
  now: string;
  invoiceId: string;
  paymentStatus?: string | null;
}) {
  const readSubscriptionMirrorCandidates = async () => {
    const existingQuery = input.supabase
      .from('user_subscriptions')
      .select('id, status, cancel_at_period_end, metadata, created_at')
      .eq('stripe_subscription_id', input.subscriptionId);
    const orderedExistingQuery = typeof existingQuery.order === 'function'
      ? existingQuery.order('created_at', { ascending: true })
      : existingQuery;
    const limitedExistingQuery = typeof orderedExistingQuery.limit === 'function'
      ? orderedExistingQuery.limit(10)
      : orderedExistingQuery;
    const existingResult = typeof limitedExistingQuery.then === 'function'
      ? await limitedExistingQuery
      : await limitedExistingQuery.maybeSingle();

    if (existingResult.error) {
      throwGrantError(
        'subscription_mirror_lookup',
        SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
        existingResult.error,
        { subscriptionId: maskIdentifier(input.subscriptionId) },
      );
    }

    return asSubscriptionRows(existingResult.data as SubscriptionRow | SubscriptionRow[] | null);
  };

  const buildPayload = (subscription: SubscriptionRow | null): SubscriptionRow => {
    const payload: SubscriptionRow = {
      user_id: input.sourceOrder.user_id,
      membership_plan_id: input.plan.id,
      stripe_customer_id: input.sourceOrder.stripe_customer_id ?? input.stripeCustomerId ?? null,
      stripe_price_id: input.sourceOrder.stripe_price_id ?? null,
      billing_cycle: input.billingCycle,
      current_period_start: input.periodStart ?? null,
      current_period_end: input.periodEnd ?? null,
      metadata: {
        ...asRecord(subscription?.metadata),
        lastInvoiceId: input.invoiceId,
        lastInvoicePaymentStatus: input.paymentStatus ?? 'paid',
        transactionId: input.transactionId ?? null,
        fulfillmentSource: 'subscription_credit_grants',
      },
      updated_at: input.now,
    };

    if (subscription?.id && shouldInitializeMirrorStatus(subscription.status)) {
      payload.status = 'active';
    }

    if (subscription?.id && shouldInitializeCancelAtPeriodEnd(subscription.cancel_at_period_end)) {
      payload.cancel_at_period_end = 'false';
    }

    return payload;
  };

  const updateExistingSubscription = async (subscription: SubscriptionRow) => {
    const updateResult = await input.supabase
      .from('user_subscriptions')
      .update(buildPayload(subscription))
      .eq('id', subscription.id)
      .select('id')
      .maybeSingle();

    if (updateResult.error) {
      throwGrantError(
        'subscription_mirror_update',
        SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
        updateResult.error,
        { subscriptionId: maskIdentifier(input.subscriptionId) },
      );
    }
  };

  const existingSubscriptions = await readSubscriptionMirrorCandidates();
  logDuplicateSubscriptionMirrors(input.subscriptionId, existingSubscriptions);

  const existingSubscription = preferCanonicalSubscriptionMirror(existingSubscriptions);
  if (existingSubscription?.id) {
    await updateExistingSubscription(existingSubscription);

    return;
  }

  const recheckedSubscriptions = await readSubscriptionMirrorCandidates();
  logDuplicateSubscriptionMirrors(input.subscriptionId, recheckedSubscriptions);
  const recheckedSubscription = preferCanonicalSubscriptionMirror(recheckedSubscriptions);
  if (recheckedSubscription?.id) {
    await updateExistingSubscription(recheckedSubscription);

    return;
  }

  const insertResult = await input.supabase
    .from('user_subscriptions')
    .insert({
      id: buildSubscriptionMirrorId(input.subscriptionId),
      ...buildPayload(null),
      stripe_subscription_id: input.subscriptionId,
      status: 'active',
      cancel_at_period_end: 'false',
    })
    .select('id')
    .maybeSingle();

  if (insertResult.error) {
    if (isUniqueViolationError(insertResult.error)) {
      logger.warn('billing', 'subscription_mirror_insert_conflict', {
        subscriptionId: maskIdentifier(input.subscriptionId),
      });

      const conflictedSubscriptions = await readSubscriptionMirrorCandidates();
      logDuplicateSubscriptionMirrors(input.subscriptionId, conflictedSubscriptions);
      const conflictedSubscription = preferCanonicalSubscriptionMirror(conflictedSubscriptions);
      if (conflictedSubscription?.id) {
        await updateExistingSubscription(conflictedSubscription);

        return;
      }
    }

    throwGrantError(
      'subscription_mirror_insert',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
      insertResult.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }
}

async function writeCompletedInvoiceOrder(input: {
  supabase: SupabaseLikeClient;
  existingInvoiceOrder: PaymentOrderRow | null;
  sourceOrder: PaymentOrderRow;
  plan: MembershipPlanRow;
  subscriptionId: string;
  invoiceId: string;
  amountTotal: number | null;
  currency?: string | null;
  paymentStatus?: string | null;
  stripeCustomerId?: string | null;
  billingCycle: SubscriptionBillingCycle;
  fulfilledAt: string;
  grantedCredits: number;
  creditTransactionId: string | null;
  grantId: string | null;
}) {
  const canPromoteCheckoutOrder = Boolean(
    input.sourceOrder.id
    && input.sourceOrder.stripe_checkout_session_id
    && !input.sourceOrder.stripe_invoice_id
    && !isSubscriptionPlanChangeOrder(input.sourceOrder),
  );
  const metadata = {
    ...asRecord(input.existingInvoiceOrder?.metadata ?? (canPromoteCheckoutOrder ? input.sourceOrder.metadata : null)),
    source: 'invoice.payment_succeeded',
    transactionId: input.creditTransactionId,
    subscriptionCreditGrantId: input.grantId,
    grantedCredits: input.grantedCredits,
    fulfillmentSource: 'subscription_credit_grants',
  };

  const payload = {
    user_id: input.sourceOrder.user_id,
    item_type: 'membership_plan',
    item_id: input.plan.id,
    billing_cycle: input.billingCycle,
    stripe_subscription_id: input.subscriptionId,
    stripe_customer_id: input.sourceOrder.stripe_customer_id ?? input.stripeCustomerId ?? null,
    stripe_price_id: input.sourceOrder.stripe_price_id ?? null,
    amount_total: input.amountTotal,
    currency: input.currency ?? 'usd',
    mode: 'subscription',
    status: 'completed',
    payment_status: input.paymentStatus ?? 'paid',
    fulfilled_at: input.fulfilledAt,
    stripe_invoice_id: input.invoiceId,
    metadata,
    updated_at: input.fulfilledAt,
  };

  if (input.existingInvoiceOrder?.id) {
    const updateResult = await input.supabase
      .from('payment_orders')
      .update(payload)
      .eq('id', input.existingInvoiceOrder.id)
      .select('id')
      .maybeSingle();

    if (updateResult.error) {
      throwGrantError(
        'subscription_invoice_order_update',
        SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
        updateResult.error,
        { invoiceId: maskIdentifier(input.invoiceId) },
      );
    }

    return updateResult.data?.id ?? input.existingInvoiceOrder.id;
  }

  const recheckedInvoiceOrder = await getExistingInvoiceOrder(input.supabase, input.invoiceId);
  if (recheckedInvoiceOrder?.id) {
    const updateResult = await input.supabase
      .from('payment_orders')
      .update({
        ...payload,
        metadata: {
          ...asRecord(recheckedInvoiceOrder.metadata),
          source: 'invoice.payment_succeeded',
          transactionId: input.creditTransactionId,
          subscriptionCreditGrantId: input.grantId,
          grantedCredits: input.grantedCredits,
          fulfillmentSource: 'subscription_credit_grants',
        },
      })
      .eq('id', recheckedInvoiceOrder.id)
      .select('id')
      .maybeSingle();

    if (updateResult.error) {
      throwGrantError(
        'subscription_invoice_order_update',
        SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
        updateResult.error,
        { invoiceId: maskIdentifier(input.invoiceId) },
      );
    }

    return updateResult.data?.id ?? recheckedInvoiceOrder.id;
  }

  if (canPromoteCheckoutOrder && input.sourceOrder.id) {
    const promotionQuery = input.supabase
      .from('payment_orders')
      .update(payload)
      .eq('id', input.sourceOrder.id);
    const guardedPromotionQuery = typeof promotionQuery.is === 'function'
      ? promotionQuery.is('stripe_invoice_id', null)
      : promotionQuery.eq('stripe_invoice_id', null);
    const updateResult = typeof guardedPromotionQuery?.select === 'function'
      ? await guardedPromotionQuery
        .select('id')
        .maybeSingle()
      : await guardedPromotionQuery;

    if (updateResult.error) {
      throwGrantError(
        'subscription_invoice_order_update',
        SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
        updateResult.error,
        { invoiceId: maskIdentifier(input.invoiceId) },
      );
    }

    if (updateResult.data?.id) {
      return updateResult.data.id;
    }

    logger.warn('billing', 'subscription_invoice_order_checkout_promotion_stale', {
      invoiceId: maskIdentifier(input.invoiceId),
      sourceOrderId: maskIdentifier(input.sourceOrder.id),
    });

    const claimedInvoiceOrder = await getExistingInvoiceOrder(input.supabase, input.invoiceId);
    if (claimedInvoiceOrder?.id) {
      const claimedUpdateResult = await input.supabase
        .from('payment_orders')
        .update({
          ...payload,
          metadata: {
            ...asRecord(claimedInvoiceOrder.metadata),
            source: 'invoice.payment_succeeded',
            transactionId: input.creditTransactionId,
            subscriptionCreditGrantId: input.grantId,
            grantedCredits: input.grantedCredits,
            fulfillmentSource: 'subscription_credit_grants',
          },
        })
        .eq('id', claimedInvoiceOrder.id)
        .select('id')
        .maybeSingle();

      if (claimedUpdateResult.error) {
        throwGrantError(
          'subscription_invoice_order_update',
          SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
          claimedUpdateResult.error,
          { invoiceId: maskIdentifier(input.invoiceId) },
        );
      }

      return claimedUpdateResult.data?.id ?? claimedInvoiceOrder.id;
    }
  }

  const insertResult = await input.supabase
    .from('payment_orders')
    .insert({
      id: buildInvoicePaymentOrderId(input.invoiceId),
      ...payload,
    })
    .select('id')
    .maybeSingle();

  if (insertResult.error) {
    if (isUniqueViolationError(insertResult.error)) {
      logger.warn('billing', 'subscription_invoice_order_insert_conflict', {
        invoiceId: maskIdentifier(input.invoiceId),
      });

      const conflictedInvoiceOrder = await getExistingInvoiceOrder(input.supabase, input.invoiceId);
      if (conflictedInvoiceOrder?.id) {
        const conflictUpdateResult = await input.supabase
          .from('payment_orders')
          .update({
            ...payload,
            metadata: {
              ...asRecord(conflictedInvoiceOrder.metadata),
              source: 'invoice.payment_succeeded',
              transactionId: input.creditTransactionId,
              subscriptionCreditGrantId: input.grantId,
              grantedCredits: input.grantedCredits,
              fulfillmentSource: 'subscription_credit_grants',
            },
          })
          .eq('id', conflictedInvoiceOrder.id)
          .select('id')
          .maybeSingle();

        if (conflictUpdateResult.error) {
          throwGrantError(
            'subscription_invoice_order_update',
            SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
            conflictUpdateResult.error,
            { invoiceId: maskIdentifier(input.invoiceId) },
          );
        }

        return conflictUpdateResult.data?.id ?? conflictedInvoiceOrder.id;
      }
    }

    throwGrantError(
      'subscription_invoice_order_insert',
      SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
      insertResult.error,
      { invoiceId: maskIdentifier(input.invoiceId) },
    );
  }

  return insertResult.data?.id ?? null;
}

async function releaseSubscriptionPlanChangeLock(input: {
  supabase: SupabaseLikeClient;
  sourceOrder: PaymentOrderRow;
  fulfilledAt: string;
  paymentStatus?: string | null;
}) {
  if (!input.sourceOrder.id || !isSubscriptionPlanChangeOrder(input.sourceOrder)) {
    return;
  }

  const result = await input.supabase
    .from('payment_orders')
    .update({
      stripe_checkout_session_id: null,
      status: 'completed',
      payment_status: input.paymentStatus ?? 'paid',
      fulfilled_at: input.fulfilledAt,
      updated_at: input.fulfilledAt,
    })
    .eq('id', input.sourceOrder.id);

  if (result.error) {
    throwGrantError(
      'subscription_plan_change_lock_release',
      SUBSCRIPTION_GRANT_ERRORS.paymentOrderWrite,
      result.error,
      { sourceOrderId: maskIdentifier(input.sourceOrder.id) },
    );
  }
}

export async function fulfillMembershipInvoiceWithSubscriptionCreditGrants(
  supabase: SupabaseLikeClient,
  input: FulfillMembershipInvoiceWithCreditGrantsInput,
) {
  const existingInvoiceOrder = await getExistingInvoiceOrder(supabase, input.invoiceId);
  const refundBlockReason = getInvoiceOrderRefundBlockReason(existingInvoiceOrder);
  if (refundBlockReason) {
    logger.warn('billing', 'subscription_invoice_fulfillment_refund_blocked', {
      invoiceId: maskIdentifier(input.invoiceId),
      subscriptionId: maskIdentifier(input.subscriptionId),
      orderId: maskIdentifier(existingInvoiceOrder?.id),
      reason: refundBlockReason,
    });

    return {
      fulfilledAt: existingInvoiceOrder?.fulfilled_at ?? null,
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: existingInvoiceOrder?.id ?? null,
      skippedReason: 'blocked_by_refund_marker',
      refundBlockReason,
    };
  }

  if (existingInvoiceOrder?.fulfilled_at) {
    const residualPlanChangeLock = await getResidualSubscriptionPlanChangeLock({
      supabase,
      subscriptionId: input.subscriptionId,
      sourceCutoff: getInvoiceSourceCutoff(input),
    });
    if (residualPlanChangeLock) {
      await releaseSubscriptionPlanChangeLock({
        supabase,
        sourceOrder: residualPlanChangeLock,
        fulfilledAt: existingInvoiceOrder.fulfilled_at,
        paymentStatus: existingInvoiceOrder.payment_status ?? input.paymentStatus,
      });
    }

    return {
      fulfilledAt: existingInvoiceOrder.fulfilled_at,
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
      invoiceOrderId: existingInvoiceOrder.id ?? null,
    };
  }

  const sourceLookup = isUsableMembershipSourceOrder(existingInvoiceOrder)
    ? {
      order: existingInvoiceOrder,
      blockedOrder: null,
      blockedReason: null,
    }
    : await getLatestSubscriptionOrder(supabase, input.subscriptionId, {
      invoiceCreatedAt: input.invoiceCreatedAt,
      periodStart: input.periodStart,
    });
  const sourceOrder = sourceLookup.order;
  if (!isUsableMembershipSourceOrder(sourceOrder)) {
    if (sourceLookup.blockedOrder?.id && sourceLookup.blockedReason) {
      logger.warn('billing', 'subscription_invoice_fulfillment_refund_source_blocked', {
        invoiceId: maskIdentifier(input.invoiceId),
        subscriptionId: maskIdentifier(input.subscriptionId),
        orderId: maskIdentifier(sourceLookup.blockedOrder.id),
        reason: sourceLookup.blockedReason,
      });

      return {
        fulfilledAt: null,
        alreadyFulfilled: true,
        grantedCredits: 0,
        creditTransactionId: null,
        invoiceOrderId: null,
        blockedSourceOrderId: sourceLookup.blockedOrder.id,
        skippedReason: 'blocked_by_refund_marker',
        refundBlockReason: sourceLookup.blockedReason,
      };
    }

    throwGrantError(
      'subscription_source_order_missing',
      SUBSCRIPTION_GRANT_ERRORS.missingSubscriptionOrder,
      new Error('subscription source order missing required fields'),
      { subscriptionId: maskIdentifier(input.subscriptionId), invoiceId: maskIdentifier(input.invoiceId) },
    );
  }

  const plan = await getMembershipPlan(supabase, sourceOrder.item_id);
  const membershipLevel = requireMembershipPlanLevel(plan, {
    membershipPlanId: maskIdentifier(plan.id),
    subscriptionId: maskIdentifier(input.subscriptionId),
    invoiceId: maskIdentifier(input.invoiceId),
  });
  const billingCycle = normalizeBillingCycle(sourceOrder.billing_cycle);
  const fulfilledAt = input.now ?? new Date().toISOString();
  const periodStart = input.periodStart ?? fulfilledAt;
  const periodEnd = input.periodEnd ?? periodStart;

  await syncProfileMembershipLevel({
    supabase,
    userId: sourceOrder.user_id,
    membershipLevel,
    subscriptionId: input.subscriptionId,
    invoiceId: input.invoiceId,
  });

  const grantPeriod: GrantPeriod = billingCycle === 'yearly'
    ? {
      periodIndex: 1,
      totalPeriods: 12,
      periodStart,
      periodEnd,
      creditsGranted: calculateAnnualMonthlyGrant(plan.yearly_credits ?? 0, 1),
      grantPeriodKey: buildAnnualGrantPeriodKey(periodStart, 1),
    }
    : {
      periodIndex: null,
      totalPeriods: 1,
      periodStart,
      periodEnd,
      creditsGranted: (plan.monthly_credits ?? 0) + (plan.monthly_bonus_credits ?? 0),
      grantPeriodKey: buildMonthlyGrantPeriodKey(input.invoiceId),
    };

  const grant = await grantSubscriptionCredits(supabase, {
    ...grantPeriod,
    userId: sourceOrder.user_id,
    membershipPlanId: plan.id,
    stripeSubscriptionId: input.subscriptionId,
    stripeInvoiceId: input.invoiceId,
    billingCycle,
    grantType: billingCycle === 'yearly' ? 'annual_monthly_release' : 'monthly_invoice',
    sourceType: 'stripe_invoice',
    sourceId: input.invoiceId,
    planName: plan.name,
    now: fulfilledAt,
  });

  await upsertSubscriptionMirror({
    supabase,
    sourceOrder,
    plan,
    subscriptionId: input.subscriptionId,
    stripeCustomerId: input.stripeCustomerId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    billingCycle,
    transactionId: grant.creditTransactionId,
    now: fulfilledAt,
    invoiceId: input.invoiceId,
    paymentStatus: input.paymentStatus,
  });

  const invoiceOrderId = await writeCompletedInvoiceOrder({
    supabase,
    existingInvoiceOrder,
    sourceOrder,
    plan,
    subscriptionId: input.subscriptionId,
    invoiceId: input.invoiceId,
    amountTotal: input.amountTotal,
    currency: input.currency,
    paymentStatus: input.paymentStatus,
    stripeCustomerId: input.stripeCustomerId,
    billingCycle,
    fulfilledAt,
    grantedCredits: grant.creditsGranted,
    creditTransactionId: grant.creditTransactionId,
    grantId: grant.grantId,
  });

  await releaseSubscriptionPlanChangeLock({
    supabase,
    sourceOrder,
    fulfilledAt,
    paymentStatus: input.paymentStatus,
  });

  if (grant.creditTransactionId && invoiceOrderId) {
    await updateCreditTransactionSemantics(supabase, {
      ...grantPeriod,
      userId: sourceOrder.user_id,
      membershipPlanId: plan.id,
      stripeSubscriptionId: input.subscriptionId,
      stripeInvoiceId: input.invoiceId,
      billingCycle,
      grantType: billingCycle === 'yearly' ? 'annual_monthly_release' : 'monthly_invoice',
      sourceType: 'stripe_invoice',
      sourceId: input.invoiceId,
      sourceOrderId: invoiceOrderId,
      planName: plan.name,
      idempotencyKey: grant.idempotencyKey,
      creditTransactionId: grant.creditTransactionId,
    });
  }

  return {
    fulfilledAt,
    alreadyFulfilled: false,
    grantedCredits: grant.creditsGranted,
    creditTransactionId: grant.creditTransactionId,
    invoiceOrderId,
  };
}

async function loadAnnualSubscriptions(supabase: SupabaseLikeClient): Promise<SubscriptionRow[]> {
  const result = await supabase
    .from('user_subscriptions')
    .select('id, user_id, membership_plan_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, billing_cycle, status, cancel_at_period_end, current_period_start, current_period_end, credit_release_terminated_at, metadata')
    .eq('billing_cycle', 'yearly');

  if (result.error) {
    throwGrantError(
      'annual_subscription_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionLookup,
      result.error,
    );
  }

  return result.data ?? [];
}

export async function releaseDueAnnualSubscriptionCredits(
  supabase: SupabaseLikeClient,
  options: { now?: Date } = {},
): Promise<AnnualReleaseResult> {
  const now = options.now ?? new Date();
  const subscriptions = await loadAnnualSubscriptions(supabase);
  const summary: AnnualReleaseResult = {
    scannedSubscriptions: subscriptions.length,
    releasedGrantCount: 0,
    releasedCredits: 0,
    skippedSubscriptions: 0,
  };

  for (const subscription of subscriptions) {
    const subscriptionId = subscription.stripe_subscription_id;
    if (!subscriptionId || !subscription.user_id || !subscription.membership_plan_id) {
      summary.skippedSubscriptions += 1;
      continue;
    }

    const invoiceId = getAnnualReleaseInvoiceId(subscription);
    const hasFullRefund = await hasSubscriptionFullRefund(supabase, {
      subscriptionId,
      invoiceId,
    });
    if (!shouldReleaseAnnualSubscriptionCredits({
      billingCycle: subscription.billing_cycle,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      hasFullRefund,
      creditReleaseTerminatedAt: subscription.credit_release_terminated_at ?? null,
      now,
    })) {
      summary.skippedSubscriptions += 1;
      continue;
    }

    const plan = await getMembershipPlan(supabase, subscription.membership_plan_id);
    const periods = getDueAnnualGrantPeriods({
      yearlyCredits: plan.yearly_credits ?? 0,
      stripeSubscriptionId: subscriptionId,
      currentPeriodStart: subscription.current_period_start ?? '',
      currentPeriodEnd: subscription.current_period_end ?? '',
      now,
    });

    for (const period of periods) {
      const grant = await grantSubscriptionCredits(supabase, {
        ...period,
        userId: subscription.user_id,
        membershipPlanId: plan.id,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: invoiceId,
        billingCycle: 'yearly',
        grantType: 'annual_monthly_release',
        sourceType: invoiceId ? 'stripe_invoice' : 'system',
        sourceId: invoiceId ?? subscriptionId,
        planName: plan.name,
        now: now.toISOString(),
      });

      if (grant.granted) {
        summary.releasedGrantCount += 1;
        summary.releasedCredits += grant.creditsGranted;
      }
    }
  }

  return summary;
}

/**
 * REFUND-1B: 只读的退款操作员预览。
 * 当期发放/已用/剩余 + 其他积分总额 + 未来释放 + 已有 termination + 在途预扣。
 * 本函数只读，不写任何表、不触发任何副作用。
 */
export interface SubscriptionRefundOperatorPreview {
  subscriptionId: string;
  userId: string | null;
  billingCycle: string | null;
  subscriptionStatus: string | null;
  currentPeriod: {
    grantId: string;
    periodKey: string;
    periodStart: string;
    periodEnd: string;
    granted: number;
    consumed: number;
    remaining: number;
  } | null;
  balance: number | null;
  otherCreditsTotal: number | null;
  futureReleases: {
    count: number;
    credits: number;
    periods: Array<{
      periodIndex: number;
      periodKey: string;
      periodStart: string;
      periodEnd: string;
      credits: number;
    }>;
  } | null;
  termination: {
    terminatedAt: string | null;
    reason: string | null;
    eventId: string | null;
    periodKey: string | null;
  };
  reversedGrantPeriodKeys: string[];
  inFlightReservations: {
    count: number;
    amountToPeriod: number;
    amountToOther: number;
    preDeductIds: string[];
  };
}

async function loadSubscriptionMirrorForPreview(
  supabase: SupabaseLikeClient,
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  const result = await supabase
    .from('user_subscriptions')
    .select('id, user_id, membership_plan_id, stripe_subscription_id, billing_cycle, status, current_period_start, current_period_end, credit_release_terminated_at, credit_release_terminated_reason, credit_release_terminated_event_id, credit_release_terminated_period_key, created_at')
    .eq('stripe_subscription_id', subscriptionId)
    .order('created_at', { ascending: true })
    .limit(10);

  if (result.error) {
    throwGrantError(
      'subscription_refund_preview_subscription_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionLookup,
      result.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  return preferCanonicalSubscriptionMirror(
    asSubscriptionRows(result.data as SubscriptionRow | SubscriptionRow[] | null),
  );
}

async function loadInFlightReservationsForPreview(input: {
  supabase: SupabaseLikeClient;
  userId: string;
  grantIds: Set<string>;
}): Promise<SubscriptionRefundOperatorPreview['inFlightReservations']> {
  const result = await input.supabase
    .from('billing_history')
    .select('id, user_id, operation_type, metadata, created_at')
    .eq('user_id', input.userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (result.error) {
    throwGrantError(
      'subscription_refund_preview_reservation_lookup',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
      result.error,
      { userId: maskIdentifier(input.userId) },
    );
  }

  const rows = (result.data ?? []) as Array<{
    id?: string | null;
    operation_type?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;

  const processedPreDeductIds = new Set<string>();
  for (const row of rows) {
    if (row.operation_type !== 'settle' && row.operation_type !== 'refund' && row.operation_type !== 'abort_settle') {
      continue;
    }
    const preDeductId = asRecord(row.metadata).preDeductId;
    if (typeof preDeductId === 'string' && preDeductId) {
      processedPreDeductIds.add(preDeductId);
    }
  }

  const preDeductIds: string[] = [];
  let amountToPeriod = 0;
  let amountToOther = 0;
  for (const row of rows) {
    if (row.operation_type !== 'pre_deduct' || !row.id || processedPreDeductIds.has(row.id)) {
      continue;
    }
    const metadata = asRecord(row.metadata);
    const chargedGrantId = typeof metadata.chargedGrantId === 'string'
      ? metadata.chargedGrantId
      : null;
    if (!chargedGrantId || !input.grantIds.has(chargedGrantId)) {
      continue;
    }
    preDeductIds.push(row.id);
    amountToPeriod += toNonNegativeInteger(metadata.amountToPeriod);
    amountToOther += toNonNegativeInteger(metadata.amountToOther);
  }

  return { count: preDeductIds.length, amountToPeriod, amountToOther, preDeductIds };
}

export async function getSubscriptionRefundOperatorPreview(
  supabase: SupabaseLikeClient,
  input: { subscriptionId: string; now?: string },
): Promise<SubscriptionRefundOperatorPreview> {
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const subscription = await loadSubscriptionMirrorForPreview(supabase, input.subscriptionId);
  const grants = await loadAllSubscriptionCreditGrants(supabase, {
    subscriptionId: input.subscriptionId,
  });

  const grantedGrants = grants.filter((grant) => grant.status === 'granted');
  const currentGrant = grantedGrants
    .filter((grant) => {
      const startMs = parseTime(grant.period_start);
      const endMs = parseTime(grant.period_end);
      return startMs !== null && endMs !== null && startMs <= nowMs && nowMs < endMs;
    })
    .sort((left, right) =>
      (parseTime(right.period_start) ?? 0) - (parseTime(left.period_start) ?? 0))[0] ?? null;

  const userId = subscription?.user_id ?? grants[0]?.user_id ?? null;
  const balance = userId ? await getProfileCreditBalance(supabase, userId) : null;
  const activeGrantsRemaining = grantedGrants.reduce(
    (sum, grant) => sum + Math.max(
      0,
      toNonNegativeInteger(grant.credits_granted) - toNonNegativeInteger(grant.consumed_amount),
    ),
    0,
  );

  let futureReleases: SubscriptionRefundOperatorPreview['futureReleases'] = null;
  if (
    subscription?.billing_cycle === 'yearly'
    && subscription.membership_plan_id
    && subscription.current_period_start
    && subscription.current_period_end
  ) {
    let plan: MembershipPlanRow | null = null;
    try {
      plan = await getMembershipPlan(supabase, subscription.membership_plan_id);
    } catch {
      plan = null;
    }

    if (plan) {
      const existingKeys = new Set(
        grants
          .filter((grant) => grant.status === 'granted' || grant.status === 'reversed')
          .map((grant) => grant.grant_period_key)
          .filter((value): value is string => Boolean(value)),
      );
      const periods = getDueAnnualGrantPeriods({
        yearlyCredits: plan.yearly_credits ?? 0,
        stripeSubscriptionId: input.subscriptionId,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        now: new Date(parseTime(subscription.current_period_end) ?? nowMs),
      })
        .filter((period) => parseTime(period.periodStart) !== null
          && (parseTime(period.periodStart) as number) > nowMs
          && !existingKeys.has(period.grantPeriodKey))
        .map((period) => ({
          periodIndex: period.periodIndex ?? 0,
          periodKey: period.grantPeriodKey,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          credits: period.creditsGranted,
        }));

      futureReleases = {
        count: periods.length,
        credits: periods.reduce((sum, period) => sum + period.credits, 0),
        periods,
      };
    }
  }

  const inFlightReservations = userId
    ? await loadInFlightReservationsForPreview({
      supabase,
      userId,
      grantIds: new Set(
        grants
          .map((grant) => grant.id)
          .filter((value): value is string => Boolean(value)),
      ),
    })
    : { count: 0, amountToPeriod: 0, amountToOther: 0, preDeductIds: [] };

  return {
    subscriptionId: input.subscriptionId,
    userId,
    billingCycle: subscription?.billing_cycle ?? null,
    subscriptionStatus: subscription?.status ?? null,
    currentPeriod: currentGrant && currentGrant.id && currentGrant.grant_period_key
      ? {
        grantId: currentGrant.id,
        periodKey: currentGrant.grant_period_key,
        periodStart: currentGrant.period_start ?? '',
        periodEnd: currentGrant.period_end ?? '',
        granted: toNonNegativeInteger(currentGrant.credits_granted),
        consumed: toNonNegativeInteger(currentGrant.consumed_amount),
        remaining: Math.max(
          0,
          toNonNegativeInteger(currentGrant.credits_granted)
            - toNonNegativeInteger(currentGrant.consumed_amount),
        ),
      }
      : null,
    balance,
    otherCreditsTotal: balance === null ? null : balance - activeGrantsRemaining,
    futureReleases,
    termination: {
      terminatedAt: subscription?.credit_release_terminated_at ?? null,
      reason: subscription?.credit_release_terminated_reason ?? null,
      eventId: subscription?.credit_release_terminated_event_id ?? null,
      periodKey: subscription?.credit_release_terminated_period_key ?? null,
    },
    reversedGrantPeriodKeys: grants
      .filter((grant) => grant.status === 'reversed' && grant.grant_period_key)
      .map((grant) => grant.grant_period_key as string),
    inFlightReservations,
  };
}
