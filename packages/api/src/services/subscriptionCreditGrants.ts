/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { logger } from '../lib/logger';
import { normalizePaymentOrderStatus } from './paymentOrderStatus';
import {
  buildSubscriptionPlanChangeLockKey,
  isSubscriptionPlanChangeOrder,
} from './subscriptionPlanChangeLock';

type SupabaseLikeClient = any;
const STRIPE_INVOICE_CREATED_SECOND_PRECISION_TOLERANCE_MS = 999;

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
  metadata?: Record<string, unknown> | null;
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
  period_index?: number | null;
  credits_granted?: number | null;
  status?: string | null;
  credit_transaction_id?: string | null;
  metadata?: Record<string, unknown> | null;
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
  now?: string;
}

export interface SubscriptionRefundCreditGrantReconciliationResult {
  orderId: string;
  subscriptionId: string;
  refundId: string | null;
  fullRefund: boolean;
  reviewRequired: boolean;
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

function normalizeBillingCycle(value: string | null | undefined): SubscriptionBillingCycle {
  return value === 'yearly' ? 'yearly' : 'monthly';
}

function isCancelAtPeriodEnd(value: string | boolean | null | undefined): boolean {
  return value === true || value === 'true';
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

function buildAnnualGrantPeriodKey(subscriptionId: string, periodStart: string, periodIndex: number) {
  return `${subscriptionId}:${periodStart.slice(0, 7)}:${String(periodIndex).padStart(2, '0')}`;
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

  const schedule = calculateAnnualMonthlyGrantSchedule(input.yearlyCredits);
  const periodMs = (endMs - startMs) / 12;
  const dueCount = Math.min(12, Math.floor((Math.min(nowMs, endMs) - startMs) / periodMs) + 1);

  return schedule.slice(0, dueCount).map((creditsGranted, index) => {
    const periodIndex = index + 1;
    const periodStart = isoFromMs(Math.round(startMs + periodMs * index));
    const periodEnd = isoFromMs(Math.round(startMs + periodMs * periodIndex));
    return {
      periodIndex,
      totalPeriods: 12,
      periodStart,
      periodEnd,
      creditsGranted,
      grantPeriodKey: buildAnnualGrantPeriodKey(input.stripeSubscriptionId, periodStart, periodIndex),
    };
  });
}

export function shouldReleaseAnnualSubscriptionCredits(input: {
  billingCycle?: string | null;
  status?: string | null;
  cancelAtPeriodEnd?: string | boolean | null;
  currentPeriodEnd?: string | null;
  hasFullRefund?: boolean;
  now?: Date;
}) {
  if (input.billingCycle !== 'yearly') {
    return false;
  }

  if (input.hasFullRefund) {
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
  if (periodEndMs !== null && nowMs >= periodEndMs && !isCancelAtPeriodEnd(input.cancelAtPeriodEnd)) {
    return status === 'active' || status === 'trialing';
  }

  return status === 'active' || status === 'trialing';
}

async function getExistingInvoiceOrder(supabase: SupabaseLikeClient, invoiceId: string): Promise<PaymentOrderRow | null> {
  const result = await supabase
    .from('payment_orders')
    .select('id, user_id, item_id, item_type, billing_cycle, status, stripe_customer_id, stripe_price_id, stripe_checkout_session_id, payment_status, fulfilled_at, created_at, metadata')
    .eq('stripe_invoice_id', invoiceId)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_invoice_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.invoiceOrderLookup,
      result.error,
      { invoiceId: maskIdentifier(invoiceId) },
    );
  }

  return result.data ?? null;
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

function toPositiveInteger(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  return 0;
}

function getLegacyGrantedCreditsFromOrderMetadata(order: PaymentOrderRow) {
  const metadata = asRecord(order.metadata);
  if (!Object.prototype.hasOwnProperty.call(metadata, 'grantedCredits')) {
    return {
      amount: 0,
      metadataGap: 'missing_grantedCredits',
    };
  }

  const grantedCredits = metadata.grantedCredits;
  if (typeof grantedCredits === 'number') {
    return Number.isFinite(grantedCredits)
      ? { amount: Math.max(Math.floor(grantedCredits), 0), metadataGap: null }
      : { amount: 0, metadataGap: 'invalid_grantedCredits' };
  }

  if (typeof grantedCredits === 'string' && /^-?\d+$/.test(grantedCredits)) {
    return {
      amount: Math.max(Number(grantedCredits), 0),
      metadataGap: null,
    };
  }

  return {
    amount: 0,
    metadataGap: 'invalid_grantedCredits',
  };
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

function parseNonNegativeIntegerSnapshot(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }

  return null;
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
  clawbackAmount?: number;
  appliedClawbackAmount?: number;
  shortfallAmount?: number;
  shortfallReason?: string | null;
  reversalStatus?: string;
  reversedGrantCount?: number;
  creditTransactionId?: string | null;
  alreadyReconciled?: boolean;
  legacyGrantRowsMissing?: boolean;
  grantedCreditsMetadataGap?: string | null;
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
      clawbackAmount: input.clawbackAmount ?? 0,
      appliedClawbackAmount: input.appliedClawbackAmount ?? input.clawbackAmount ?? 0,
      shortfallAmount: input.shortfallAmount ?? 0,
      shortfallReason: input.shortfallReason ?? null,
      reversedGrantCount: input.reversedGrantCount ?? 0,
      creditTransactionId: input.creditTransactionId ?? null,
      alreadyReconciled: input.alreadyReconciled ?? false,
      ...(input.legacyGrantRowsMissing ? { legacyGrantRowsMissing: true } : {}),
      ...(input.grantedCreditsMetadataGap ? { grantedCreditsMetadataGap: input.grantedCreditsMetadataGap } : {}),
      idempotencyKey: input.idempotencyKey,
      reversalStatus: input.reversalStatus ?? (input.reviewRequired ? 'review_required' : 'complete'),
      reconciledAt: input.now,
      source: 'subscription_credit_grants_refund_reconciliation',
    },
  };
}

function getExistingRefundReversalMetadata(
  order: PaymentOrderRow,
  input: { idempotencyKey: string; invoiceId?: string | null },
): (Pick<SubscriptionRefundCreditGrantReconciliationResult,
  | 'reviewRequired'
  | 'reversedGrantCount'
  | 'clawbackAmount'
  | 'appliedClawbackAmount'
  | 'shortfallAmount'
  | 'creditTransactionId'
  | 'alreadyReconciled'
> & { reversalStatus: string | null }) | null {
  const reversal = asRecord(asRecord(order.metadata).subscriptionCreditGrantReversal);
  const reversalInvoiceId = typeof reversal.invoiceId === 'string'
    ? reversal.invoiceId
    : null;
  const invoiceId = input.invoiceId?.trim() || null;
  const matchesReconciliation = reversal.idempotencyKey === input.idempotencyKey
    || Boolean(invoiceId && reversalInvoiceId === invoiceId);
  if (
    reversal.fullRefund !== true
    || !matchesReconciliation
  ) {
    return null;
  }

  const reversalStatus = typeof reversal.reversalStatus === 'string'
    ? reversal.reversalStatus
    : null;
  if (reversalStatus === 'pending') {
    return null;
  }

  const clawbackAmount = toNonNegativeInteger(reversal.clawbackAmount);
  const appliedClawbackAmount = toNonNegativeInteger(
    reversal.appliedClawbackAmount ?? reversal.clawbackAmount,
  );

  return {
    reviewRequired: reversal.reviewRequired === true,
    reversedGrantCount: toNonNegativeInteger(reversal.reversedGrantCount),
    clawbackAmount,
    appliedClawbackAmount,
    shortfallAmount: toNonNegativeInteger(reversal.shortfallAmount),
    creditTransactionId: typeof reversal.creditTransactionId === 'string'
      ? reversal.creditTransactionId
      : null,
    alreadyReconciled: true,
    reversalStatus,
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
  clawbackAmount?: number;
  appliedClawbackAmount?: number;
  shortfallAmount?: number;
  shortfallReason?: string | null;
  reversalStatus?: string;
  reversedGrantCount?: number;
  creditTransactionId?: string | null;
  alreadyReconciled?: boolean;
  legacyGrantRowsMissing?: boolean;
  grantedCreditsMetadataGap?: string | null;
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
        clawbackAmount: input.clawbackAmount,
        appliedClawbackAmount: input.appliedClawbackAmount,
        shortfallAmount: input.shortfallAmount,
        shortfallReason: input.shortfallReason,
        reversalStatus: input.reversalStatus,
        reversedGrantCount: input.reversedGrantCount,
        creditTransactionId: input.creditTransactionId,
        alreadyReconciled: input.alreadyReconciled,
        legacyGrantRowsMissing: input.legacyGrantRowsMissing,
        grantedCreditsMetadataGap: input.grantedCreditsMetadataGap,
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

async function loadSubscriptionCreditGrantsForRefund(
  supabase: SupabaseLikeClient,
  input: { subscriptionId: string; invoiceId: string },
): Promise<SubscriptionCreditGrantRow[]> {
  const result = await supabase
    .from('subscription_credit_grants')
    .select('id, user_id, membership_plan_id, stripe_subscription_id, stripe_invoice_id, billing_cycle, grant_type, grant_period_key, period_index, credits_granted, status, credit_transaction_id, metadata')
    .eq('stripe_subscription_id', input.subscriptionId)
    .eq('stripe_invoice_id', input.invoiceId);

  if (result.error) {
    throwGrantError(
      'subscription_refund_credit_grant_lookup',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
      result.error,
      { subscriptionId: maskIdentifier(input.subscriptionId), invoiceId: maskIdentifier(input.invoiceId) },
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

function isRefundableGrantForReconciliation(
  grant: SubscriptionCreditGrantRow,
  input: { idempotencyKey: string; invoiceId?: string | null },
) {
  if (toPositiveInteger(grant.credits_granted) <= 0) {
    return false;
  }

  if (grant.status === 'granted') {
    return true;
  }

  const reversal = asRecord(asRecord(grant.metadata).reversal);
  const reversalInvoiceId = typeof reversal.invoiceId === 'string'
    ? reversal.invoiceId
    : null;
  const invoiceId = input.invoiceId?.trim() || null;
  return grant.status === 'reversed'
    && (
      reversal.idempotencyKey === input.idempotencyKey
      || Boolean(invoiceId && reversalInvoiceId === invoiceId)
    );
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

async function markSubscriptionCreditGrantReversed(input: {
  supabase: SupabaseLikeClient;
  grant: SubscriptionCreditGrantRow;
  refund: ReconcileSubscriptionRefundCreditGrantsInput;
  now: string;
  transactionId: string | null;
  idempotencyKey: string;
  reviewRequired: boolean;
  clawbackAmount: number;
  appliedClawbackAmount: number;
  shortfallAmount: number;
  shortfallReason: string | null;
}) {
  if (!input.grant.id) {
    return;
  }

  const result = await input.supabase
    .from('subscription_credit_grants')
    .update({
      status: 'reversed',
      updated_at: input.now,
      metadata: {
        ...asRecord(input.grant.metadata),
        reversal: {
          refundId: input.refund.refundId ?? null,
          subscriptionId: input.refund.subscriptionId,
          invoiceId: input.refund.invoiceId ?? null,
          creditTransactionId: input.transactionId,
          idempotencyKey: input.idempotencyKey,
          reviewRequired: input.reviewRequired,
          clawbackAmount: input.clawbackAmount,
          appliedClawbackAmount: input.appliedClawbackAmount,
          shortfallAmount: input.shortfallAmount,
          shortfallReason: input.shortfallReason,
          reversedAt: input.now,
          source: 'subscription_refund',
        },
      },
    })
    .eq('id', input.grant.id);

  if (result.error) {
    throwGrantError(
      'subscription_refund_credit_grant_reversal',
      SUBSCRIPTION_GRANT_ERRORS.refundCreditGrantReversal,
      result.error,
      { grantId: maskIdentifier(input.grant.id), subscriptionId: maskIdentifier(input.refund.subscriptionId) },
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
  const legacyIdempotencyKey = buildLegacySubscriptionRefundIdempotencyKey(scopedRefund);

  if (!input.isFullRefund) {
    await updateSubscriptionRefundOrder({
      supabase,
      order,
      refund: scopedRefund,
      now,
      idempotencyKey,
      reviewRequired: true,
      reversalStatus: 'partial_refund_review_required',
    });

    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: false,
      reviewRequired: true,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
      alreadyReconciled: false,
    };
  }

  const existingReversal = getExistingRefundReversalMetadata(order, {
    idempotencyKey,
    invoiceId: invoiceScope.invoiceId,
  });
  if (existingReversal) {
    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: true,
      reviewRequired: existingReversal.reviewRequired,
      reversedGrantCount: existingReversal.reversedGrantCount,
      clawbackAmount: existingReversal.clawbackAmount,
      appliedClawbackAmount: existingReversal.appliedClawbackAmount,
      shortfallAmount: existingReversal.shortfallAmount,
      creditTransactionId: existingReversal.creditTransactionId,
      alreadyReconciled: true,
    };
  }

  const existingReversalMetadata = asRecord(
    asRecord(order.metadata).subscriptionCreditGrantReversal,
  );
  const existingReversalIdempotencyKey = typeof existingReversalMetadata.idempotencyKey === 'string'
    ? existingReversalMetadata.idempotencyKey.trim()
    : null;
  const existingShortfallReason = typeof existingReversalMetadata.shortfallReason === 'string'
    ? existingReversalMetadata.shortfallReason
    : null;

  await updateSubscriptionRefundOrder({
    supabase,
    order,
    refund: scopedRefund,
    now,
    idempotencyKey,
    reviewRequired: true,
    reversalStatus: 'pending',
    orderStatus: 'partially_refunded',
    paymentStatus: 'partially_refunded',
  });

  if (!invoiceScope.invoiceId) {
    await updateSubscriptionRefundOrder({
      supabase,
      order,
      refund: scopedRefund,
      now,
      idempotencyKey,
      reviewRequired: true,
      shortfallReason: invoiceScope.reason,
      reversalStatus: invoiceScope.status,
      orderStatus: 'partially_refunded',
      paymentStatus: 'partially_refunded',
    });

    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: true,
      reviewRequired: true,
      reversedGrantCount: 0,
      clawbackAmount: 0,
      appliedClawbackAmount: 0,
      shortfallAmount: 0,
      creditTransactionId: null,
      alreadyReconciled: false,
    };
  }

  const grants = await loadSubscriptionCreditGrantsForRefund(supabase, {
    subscriptionId: input.subscriptionId,
    invoiceId: invoiceScope.invoiceId,
  });
  const refundableGrants = grants.filter((grant) =>
    isRefundableGrantForReconciliation(grant, {
      idempotencyKey,
      invoiceId: invoiceScope.invoiceId,
    }),
  );
  const legacyGrantedCredits = getLegacyGrantedCreditsFromOrderMetadata(order);
  const shouldApplyLegacyGrantFallback = refundableGrants.length === 0
    && (
      legacyGrantedCredits.amount > 0
      || legacyGrantedCredits.metadataGap !== null
    );

  if (shouldApplyLegacyGrantFallback) {
    const clawbackAmount = legacyGrantedCredits.amount;
    const userId = order.user_id ?? null;
    let creditTransactionId: string | null = null;
    let alreadyReconciled = false;
    let appliedClawbackAmount = 0;
    let shortfallAmount = clawbackAmount;
    let shortfallReason: string | null = legacyGrantedCredits.metadataGap
      ?? 'legacy_subscription_grant_rows_missing';

    if (userId && clawbackAmount > 0) {
      const refundIdempotencyKeys = collectSubscriptionRefundIdempotencyKeys({
        order,
        grants: [],
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
      } else {
        const currentBalance = await getProfileCreditBalance(supabase, userId);
        appliedClawbackAmount = Math.min(clawbackAmount, currentBalance ?? 0);
        shortfallAmount = clawbackAmount - appliedClawbackAmount;
        shortfallReason = currentBalance === null
          ? 'profile_missing'
          : 'legacy_subscription_grant_rows_missing';

        if (appliedClawbackAmount > 0) {
          creditTransactionId = await applySubscriptionRefundClawback({
            supabase,
            userId,
            amount: appliedClawbackAmount,
            refund: scopedRefund,
            idempotencyKey,
            reversedGrantCount: 0,
          });
          await updateRefundClawbackTransactionSemantics({
            supabase,
            transactionId: creditTransactionId,
            refund: scopedRefund,
            idempotencyKey,
            amount: appliedClawbackAmount,
            requiredAmount: clawbackAmount,
            shortfallAmount,
            reversedGrantCount: 0,
            reversedGrantPeriodKeys: [],
          });
        }
      }
    } else if (clawbackAmount > 0) {
      shortfallReason = 'user_missing';
    } else {
      shortfallAmount = 0;
    }

    await updateSubscriptionRefundOrder({
      supabase,
      order,
      refund: scopedRefund,
      now,
      idempotencyKey,
      reviewRequired: true,
      clawbackAmount,
      appliedClawbackAmount,
      shortfallAmount,
      shortfallReason,
      reversalStatus: 'legacy_grant_rows_missing_review_required',
      reversedGrantCount: 0,
      creditTransactionId,
      alreadyReconciled,
      legacyGrantRowsMissing: true,
      grantedCreditsMetadataGap: legacyGrantedCredits.metadataGap,
    });

    return {
      orderId: order.id as string,
      subscriptionId: input.subscriptionId,
      refundId: input.refundId ?? null,
      fullRefund: true,
      reviewRequired: true,
      reversedGrantCount: 0,
      clawbackAmount,
      appliedClawbackAmount,
      shortfallAmount,
      creditTransactionId,
      alreadyReconciled,
    };
  }

  const grantsToReverse = refundableGrants.filter((grant) => grant.status === 'granted');
  const userId = order.user_id ?? refundableGrants[0]?.user_id ?? null;
  const clawbackAmount = refundableGrants.reduce(
    (sum, grant) => sum + toPositiveInteger(grant.credits_granted),
    0,
  );
  let creditTransactionId: string | null = null;
  let alreadyReconciled = false;
  let appliedClawbackAmount = 0;
  let shortfallAmount = clawbackAmount;
  let shortfallReason: string | null = clawbackAmount > 0 ? 'clawback_not_applied' : null;

  if (userId) {
    const refundIdempotencyKeys = collectSubscriptionRefundIdempotencyKeys({
      order,
      grants: refundableGrants,
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
          reversedGrantCount: refundableGrants.length,
          reversedGrantPeriodKeys: refundableGrants
            .map((grant) => grant.grant_period_key)
            .filter((value): value is string => Boolean(value)),
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
          reversedGrantCount: refundableGrants.length,
        });
        await updateRefundClawbackTransactionSemantics({
          supabase,
          transactionId: creditTransactionId,
          refund: scopedRefund,
          idempotencyKey,
          amount: appliedClawbackAmount,
          requiredAmount: clawbackAmount,
          shortfallAmount,
          reversedGrantCount: refundableGrants.length,
          reversedGrantPeriodKeys: refundableGrants
            .map((grant) => grant.grant_period_key)
            .filter((value): value is string => Boolean(value)),
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

  for (const grant of grantsToReverse) {
    await markSubscriptionCreditGrantReversed({
      supabase,
      grant,
      refund: scopedRefund,
      now,
      transactionId: creditTransactionId,
      idempotencyKey,
      reviewRequired,
      clawbackAmount,
      appliedClawbackAmount,
      shortfallAmount,
      shortfallReason,
    });
  }

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
    reversedGrantCount: refundableGrants.length,
    creditTransactionId,
    alreadyReconciled,
  });

  return {
    orderId: order.id as string,
    subscriptionId: input.subscriptionId,
    refundId: input.refundId ?? null,
    fullRefund: true,
    reviewRequired,
    reversedGrantCount: refundableGrants.length,
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
  const existingResult = await input.supabase
    .from('user_subscriptions')
    .select('id, status, cancel_at_period_end, metadata')
    .eq('stripe_subscription_id', input.subscriptionId)
    .maybeSingle();

  if (existingResult.error) {
    throwGrantError(
      'subscription_mirror_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionWrite,
      existingResult.error,
      { subscriptionId: maskIdentifier(input.subscriptionId) },
    );
  }

  const existingSubscription = existingResult.data as SubscriptionRow | null;
  const payload: SubscriptionRow = {
    user_id: input.sourceOrder.user_id,
    membership_plan_id: input.plan.id,
    stripe_customer_id: input.sourceOrder.stripe_customer_id ?? input.stripeCustomerId ?? null,
    stripe_price_id: input.sourceOrder.stripe_price_id ?? null,
    billing_cycle: input.billingCycle,
    current_period_start: input.periodStart ?? null,
    current_period_end: input.periodEnd ?? null,
    metadata: {
      ...asRecord(existingSubscription?.metadata),
      lastInvoiceId: input.invoiceId,
      lastInvoicePaymentStatus: input.paymentStatus ?? 'paid',
      transactionId: input.transactionId ?? null,
      fulfillmentSource: 'subscription_credit_grants',
      ...(input.billingCycle === 'yearly'
        ? { annualGrantYearlyCredits: input.plan.yearly_credits ?? 0 }
        : {}),
    },
    updated_at: input.now,
  };

  if (existingSubscription?.id) {
    if (shouldInitializeMirrorStatus(existingSubscription.status)) {
      payload.status = 'active';
    }

    if (shouldInitializeCancelAtPeriodEnd(existingSubscription.cancel_at_period_end)) {
      payload.cancel_at_period_end = 'false';
    }

    const updateResult = await input.supabase
      .from('user_subscriptions')
      .update(payload)
      .eq('id', existingSubscription.id)
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

    return;
  }

  const insertResult = await input.supabase
    .from('user_subscriptions')
    .insert({
      ...payload,
      stripe_subscription_id: input.subscriptionId,
      status: 'active',
      cancel_at_period_end: 'false',
    })
    .select('id')
    .maybeSingle();

  if (insertResult.error) {
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
  const metadata = {
    ...asRecord(input.existingInvoiceOrder?.metadata),
    source: 'invoice.payment_succeeded',
    transactionId: input.creditTransactionId,
    subscriptionCreditGrantId: input.grantId,
    grantedCredits: input.grantedCredits,
    fulfillmentSource: 'subscription_credit_grants',
    ...(input.billingCycle === 'yearly'
      ? { annualGrantYearlyCredits: input.plan.yearly_credits ?? 0 }
      : {}),
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

  const insertResult = await input.supabase
    .from('payment_orders')
    .insert({
      ...payload,
      stripe_invoice_id: input.invoiceId,
    })
    .select('id')
    .maybeSingle();

  if (insertResult.error) {
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
      grantPeriodKey: buildAnnualGrantPeriodKey(input.subscriptionId, periodStart, 1),
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
    .select('id, user_id, membership_plan_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, billing_cycle, status, cancel_at_period_end, current_period_start, current_period_end, metadata')
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

async function hasAnnualReleaseGrantRows(supabase: SupabaseLikeClient, input: {
  subscriptionId: string;
  invoiceId: string;
}) {
  const result = await supabase
    .from('subscription_credit_grants')
    .select('id')
    .eq('stripe_subscription_id', input.subscriptionId)
    .eq('stripe_invoice_id', input.invoiceId)
    .limit(1);

  if (result.error) {
    throwGrantError(
      'annual_release_credit_grant_lookup',
      SUBSCRIPTION_GRANT_ERRORS.creditGrantLookup,
      result.error,
      { subscriptionId: maskIdentifier(input.subscriptionId), invoiceId: maskIdentifier(input.invoiceId) },
    );
  }

  return (result.data ?? []).length > 0;
}

async function getAnnualReleaseInvoiceOrder(supabase: SupabaseLikeClient, input: {
  subscriptionId: string;
  invoiceId: string;
}) {
  const result = await supabase
    .from('payment_orders')
    .select('id, metadata')
    .eq('stripe_subscription_id', input.subscriptionId)
    .eq('stripe_invoice_id', input.invoiceId)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'annual_release_invoice_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.invoiceOrderLookup,
      result.error,
      { subscriptionId: maskIdentifier(input.subscriptionId), invoiceId: maskIdentifier(input.invoiceId) },
    );
  }

  return result.data ?? null;
}

function getAnnualReleaseYearlyCredits(input: {
  subscription: SubscriptionRow;
  invoiceOrder: PaymentOrderRow | null;
  plan: MembershipPlanRow;
}) {
  const subscriptionMetadata = asRecord(input.subscription.metadata);
  const invoiceMetadata = asRecord(input.invoiceOrder?.metadata);
  return parseNonNegativeIntegerSnapshot(subscriptionMetadata.annualGrantYearlyCredits)
    ?? parseNonNegativeIntegerSnapshot(subscriptionMetadata.annualGrantTotalCredits)
    ?? parseNonNegativeIntegerSnapshot(invoiceMetadata.annualGrantYearlyCredits)
    ?? parseNonNegativeIntegerSnapshot(invoiceMetadata.annualGrantTotalCredits)
    ?? toPositiveInteger(input.plan.yearly_credits);
}

async function hasLegacyFullYearAnnualGrant(supabase: SupabaseLikeClient, input: {
  subscriptionId: string;
  invoiceId: string;
  yearlyCredits: number;
  invoiceOrder?: PaymentOrderRow | null;
}) {
  if (input.yearlyCredits <= 0) {
    return false;
  }

  if (await hasAnnualReleaseGrantRows(supabase, input)) {
    return false;
  }

  const invoiceOrder = input.invoiceOrder ?? await getAnnualReleaseInvoiceOrder(supabase, input);
  const legacyGrantedCredits = invoiceOrder
    ? getLegacyGrantedCreditsFromOrderMetadata(invoiceOrder)
    : { amount: 0, metadataGap: 'missing_grantedCredits' };

  return legacyGrantedCredits.amount > 0;
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
    if (!invoiceId) {
      summary.skippedSubscriptions += 1;
      continue;
    }

    const hasFullRefund = await hasSubscriptionFullRefund(supabase, {
      subscriptionId,
      invoiceId,
    });
    if (!shouldReleaseAnnualSubscriptionCredits({
      billingCycle: subscription.billing_cycle,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: subscription.current_period_end,
      hasFullRefund,
      now,
    })) {
      summary.skippedSubscriptions += 1;
      continue;
    }

    const plan = await getMembershipPlan(supabase, subscription.membership_plan_id);
    const invoiceOrder = await getAnnualReleaseInvoiceOrder(supabase, {
      subscriptionId,
      invoiceId,
    });
    const yearlyCredits = getAnnualReleaseYearlyCredits({
      subscription,
      invoiceOrder,
      plan,
    });
    if (await hasLegacyFullYearAnnualGrant(supabase, {
      subscriptionId,
      invoiceId,
      yearlyCredits,
      invoiceOrder,
    })) {
      summary.skippedSubscriptions += 1;
      continue;
    }

    const periods = getDueAnnualGrantPeriods({
      yearlyCredits,
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
        sourceType: 'stripe_invoice',
        sourceId: invoiceId,
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
