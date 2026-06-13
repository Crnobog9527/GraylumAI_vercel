/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { logger } from '../lib/logger';

type SupabaseLikeClient = any;

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
  fulfilled_at?: string | null;
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

  const status = input.status ?? '';
  const periodEndMs = parseTime(input.currentPeriodEnd);
  const nowMs = (input.now ?? new Date()).getTime();
  if (status === 'canceled' && periodEndMs !== null && nowMs >= periodEndMs) {
    return false;
  }

  if (periodEndMs !== null && nowMs >= periodEndMs && !isCancelAtPeriodEnd(input.cancelAtPeriodEnd)) {
    return status === 'active' || status === 'trialing';
  }

  if (status === 'past_due' || status === 'incomplete' || status === 'unpaid') {
    return false;
  }

  return status === 'active' || status === 'trialing' || isCancelAtPeriodEnd(input.cancelAtPeriodEnd);
}

async function getExistingInvoiceOrder(supabase: SupabaseLikeClient, invoiceId: string): Promise<PaymentOrderRow | null> {
  const result = await supabase
    .from('payment_orders')
    .select('id, user_id, item_id, item_type, billing_cycle, status, stripe_customer_id, stripe_price_id, fulfilled_at, metadata')
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

async function getLatestSubscriptionOrder(
  supabase: SupabaseLikeClient,
  subscriptionId: string,
): Promise<PaymentOrderRow | null> {
  const query = supabase
    .from('payment_orders')
    .select('id, user_id, item_id, item_type, billing_cycle, status, stripe_customer_id, stripe_price_id, metadata')
    .eq('stripe_subscription_id', subscriptionId)
    .order('created_at', { ascending: false })
    .limit(10);
  const result = typeof query.then === 'function'
    ? await query
    : await query.maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_source_order_lookup',
      SUBSCRIPTION_GRANT_ERRORS.subscriptionOrderLookup,
      result.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  return Array.isArray(result.data)
    ? (result.data as PaymentOrderRow[]).find((order: PaymentOrderRow) => order.status !== 'failed') ?? null
    : result.data ?? null;
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
  subscriptionId: string,
): Promise<boolean> {
  const result = await supabase
    .from('payment_orders')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .eq('status', 'refunded')
    .limit(1)
    .maybeSingle();

  if (result.error) {
    throwGrantError(
      'subscription_full_refund_lookup',
      SUBSCRIPTION_GRANT_ERRORS.refundLookup,
      result.error,
      { subscriptionId: maskIdentifier(subscriptionId) },
    );
  }

  return Boolean(result.data?.id);
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

export async function fulfillMembershipInvoiceWithSubscriptionCreditGrants(
  supabase: SupabaseLikeClient,
  input: FulfillMembershipInvoiceWithCreditGrantsInput,
) {
  const existingInvoiceOrder = await getExistingInvoiceOrder(supabase, input.invoiceId);
  const sourceOrder = isUsableMembershipSourceOrder(existingInvoiceOrder)
    ? existingInvoiceOrder
    : await getLatestSubscriptionOrder(supabase, input.subscriptionId);
  if (!isUsableMembershipSourceOrder(sourceOrder)) {
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

  if (existingInvoiceOrder?.fulfilled_at) {
    return {
      fulfilledAt: existingInvoiceOrder.fulfilled_at,
      alreadyFulfilled: true,
      grantedCredits: 0,
      creditTransactionId: null,
    };
  }

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

    const hasFullRefund = await hasSubscriptionFullRefund(supabase, subscriptionId);
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
    const periods = getDueAnnualGrantPeriods({
      yearlyCredits: plan.yearly_credits ?? 0,
      stripeSubscriptionId: subscriptionId,
      currentPeriodStart: subscription.current_period_start ?? '',
      currentPeriodEnd: subscription.current_period_end ?? '',
      now,
    });

    for (const period of periods) {
      const invoiceId = typeof subscription.metadata?.lastInvoiceId === 'string'
        ? subscription.metadata.lastInvoiceId
        : null;
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
