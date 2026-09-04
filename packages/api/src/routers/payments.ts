/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type Stripe from 'stripe';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { logger } from '../lib/logger';
import { createSafeInternalError, createSafeServiceUnavailableError } from '../lib/publicError';
import {
  assertStripeCheckoutConfigured,
  assertCheckoutRateLimit,
  assertSubscriptionChangeRateLimit,
  buildStripeMetadata,
  calculateDiscountedAmountCents,
  getOrCreateStripeCustomerId,
  getStripeAppUrl,
  getStripeClient,
  getStripePortalReturnUrl,
} from '../services/stripe';
import {
  fulfillCreditPackageOrder,
  fulfillPaidMembershipCheckoutSession,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '../services/stripeFulfillment';
import {
  normalizePaymentOrderStatus,
  type PaymentOrderStatus,
} from '../services/paymentOrderStatus';
import {
  resolveMembershipEligibility,
  type MembershipEligibilityResult,
  type MembershipBillingCycle,
} from '../services/membershipEligibility';
import {
  buildSubscriptionPlanChangeLockKey,
  isSubscriptionPlanChangeOrder,
} from '../services/subscriptionPlanChangeLock';
import { isStripeManagedSubscriptionActive } from '../services/subscriptionOverrides';

const createCheckoutInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('credit_package'),
    packageId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('membership_plan'),
    planId: z.string().uuid(),
    billingCycle: z.enum(['monthly', 'yearly']),
  }),
]);

const syncCheckoutInput = z.object({
  sessionId: z.string().min(1),
  checkoutState: z.enum(['success', 'canceled', 'cancelled']).optional(),
});

const changeSubscriptionPlanInput = z.object({
  planId: z.string().uuid(),
  billingCycle: z.enum(['monthly', 'yearly']),
}).strict();

const upgradeQuoteSchema = z.object({
  amountDue: z.number().int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  prorationDate: z.number().int().positive(),
  fingerprint: z.string().length(64),
}).strict();
type UpgradeQuote = z.infer<typeof upgradeQuoteSchema>;

type BillingRecord = {
  id: string;
  itemType: 'credit_package' | 'membership_plan';
  title: string;
  description: string;
  status: string;
  amountTotal: number;
  currency: string;
  billingCycle: 'one_time' | 'monthly' | 'yearly';
  createdAt: string;
  fulfilledAt: string | null;
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  receiptUrl: string | null;
};

type PaymentOrderBillingRow = {
  id: string;
  item_id: string;
  item_type: 'credit_package' | 'membership_plan' | string;
  billing_cycle: 'one_time' | 'monthly' | 'yearly' | null;
  stripe_checkout_session_id: string | null;
  stripe_invoice_id: string | null;
  amount_total: number | string | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
  fulfilled_at: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

type CreateCheckoutInput = z.infer<typeof createCheckoutInput>;
type ChangeSubscriptionPlanInput = z.infer<typeof changeSubscriptionPlanInput>;

type MembershipPlanPaymentRow = {
  id: string;
  name: string;
  level: string;
  is_active: string;
  stripe_monthly_price_id: string | null;
  stripe_yearly_price_id: string | null;
  monthly_price: unknown;
  yearly_price: unknown;
};

type StripeManagedSubscriptionRow = {
  id: string;
  membership_plan_id: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  status: string | null;
  billing_cycle: MembershipBillingCycle | null;
  stripe_price_id: string | null;
  cancel_at_period_end: string | boolean | null;
};

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function maskKnownIdentifiers(message: string | null | undefined) {
  if (!message) {
    return null;
  }

  return message
    .replace(
      /\b(?:cs_(?:test|live)|sub|in|cus|price|pi|ch)_[A-Za-z0-9_]+\b/g,
      (value) => maskIdentifier(value) ?? value,
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[masked-email]',
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (value) => maskIdentifier(value) ?? value,
    );
}

function summarizePaymentError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      name: null,
      type: null,
      code: null,
      statusCode: null,
      message: typeof error === 'string' ? maskKnownIdentifiers(error.slice(0, 240)) : null,
    };
  }

  const errorRecord = error as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    stage?: unknown;
    safeContext?: unknown;
    raw?: {
      type?: unknown;
      code?: unknown;
      message?: unknown;
    };
  };

  const rawMessage = typeof errorRecord.raw?.message === 'string'
      ? errorRecord.raw.message
      : typeof errorRecord.message === 'string'
        ? errorRecord.message
        : null;

  return {
    name: typeof errorRecord.name === 'string' ? errorRecord.name : null,
    type: typeof errorRecord.raw?.type === 'string'
      ? errorRecord.raw.type
      : typeof errorRecord.type === 'string'
        ? errorRecord.type
        : null,
    code: typeof errorRecord.raw?.code === 'string'
      ? errorRecord.raw.code
      : typeof errorRecord.code === 'string'
        ? errorRecord.code
        : null,
    statusCode: typeof errorRecord.statusCode === 'number'
      ? errorRecord.statusCode
      : typeof errorRecord.status === 'number'
        ? errorRecord.status
        : null,
    stage: typeof errorRecord.stage === 'string' ? errorRecord.stage : null,
    safeContext: errorRecord.safeContext && typeof errorRecord.safeContext === 'object'
      ? errorRecord.safeContext
      : null,
    message: maskKnownIdentifiers(rawMessage?.slice(0, 240)) ?? null,
  };
}

function getCheckoutItemId(input: CreateCheckoutInput) {
  return input.kind === 'credit_package' ? input.packageId : input.planId;
}

function logCheckoutStageFailure(
  stage: string,
  input: CreateCheckoutInput,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  logger.error('billing', 'payments_checkout_stage_failed', {
    stage,
    kind: input.kind,
    itemId: getCheckoutItemId(input),
    ...extra,
    error: summarizePaymentError(error),
  });
}

function logSubscriptionChangeStageFailure(
  stage: string,
  input: ChangeSubscriptionPlanInput,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  logger.error('billing', 'payments_change_subscription_plan_stage_failed', {
    stage,
    planId: input.planId,
    billingCycle: input.billingCycle,
    ...extra,
    error: summarizePaymentError(error),
  });
}

function toCheckoutConfigError(message: string) {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message,
  });
}

function createPaymentOperationError(operation: string, cause: unknown) {
  return createSafeInternalError(cause, `${operation}失败，请稍后重试`);
}

function normalizeCheckoutPriceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function readMembershipEligibilityData<T>(
  query: PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  let result;

  try {
    result = await query;
  } catch (error) {
    throw createSafeServiceUnavailableError(
      error,
      '会员状态暂不可用，请稍后重试',
    );
  }

  if (result.error) {
    throw createSafeServiceUnavailableError(
      result.error,
      '会员状态暂不可用，请稍后重试',
    );
  }

  return result.data;
}

async function readCheckoutData<T>(input: {
  query: PromiseLike<{ data: T | null; error: unknown }>;
  checkoutInput: CreateCheckoutInput;
  stage: string;
  operation: string;
  extra?: Record<string, unknown>;
}): Promise<T | null> {
  let result;

  try {
    result = await input.query;
  } catch (error) {
    logCheckoutStageFailure(input.stage, input.checkoutInput, error, input.extra);
    throw createSafeServiceUnavailableError(error, `${input.operation}暂不可用，请稍后重试`);
  }

  if (result.error) {
    logCheckoutStageFailure(input.stage, input.checkoutInput, result.error, input.extra);
    throw createSafeServiceUnavailableError(
      result.error,
      `${input.operation}暂不可用，请稍后重试`,
    );
  }

  return result.data;
}

async function readSubscriptionChangeData<T>(input: {
  query: PromiseLike<{ data: T | null; error: unknown }>;
  changeInput: ChangeSubscriptionPlanInput;
  stage: string;
  operation: string;
}): Promise<T | null> {
  let result;

  try {
    result = await input.query;
  } catch (error) {
    logSubscriptionChangeStageFailure(input.stage, input.changeInput, error);
    throw createSafeServiceUnavailableError(
      error,
      `${input.operation}暂不可用，请稍后重试`,
    );
  }

  if (result.error) {
    logSubscriptionChangeStageFailure(input.stage, input.changeInput, result.error);
    throw createSafeServiceUnavailableError(
      result.error,
      `${input.operation}暂不可用，请稍后重试`,
    );
  }

  return result.data;
}

function getCheckoutSessionSubscriptionId(session: any) {
  return typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null;
}

function getCheckoutSessionInvoiceId(session: any) {
  return typeof session.invoice === 'string'
    ? session.invoice
    : session.invoice?.id ?? null;
}

function isCanceledCheckoutState(checkoutState: z.infer<typeof syncCheckoutInput>['checkoutState']) {
  return checkoutState === 'canceled' || checkoutState === 'cancelled';
}

function logSyncCheckoutStage(
  stage: string,
  input: z.infer<typeof syncCheckoutInput>,
  extra: Record<string, unknown> = {},
) {
  logger.info('billing', 'payments_sync_checkout_stage', {
    stage,
    checkoutSessionId: maskIdentifier(input.sessionId),
    ...extra,
  });
}

function logSyncCheckoutStageFailure(
  stage: string,
  input: z.infer<typeof syncCheckoutInput>,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  logger.error('billing', 'payments_sync_checkout_stage_failed', {
    stage,
    checkoutSessionId: maskIdentifier(input.sessionId),
    ...extra,
    error: summarizePaymentError(error),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getAuditString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? maskKnownIdentifiers(value.slice(0, 160)) : null;
}

function getAuditNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getAuditStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => maskKnownIdentifiers(item.slice(0, 80)) ?? item.slice(0, 80));
}

function buildSyncCheckoutInvoiceResolutionAudit(error: unknown) {
  const summary = summarizePaymentError(error);
  const safeContext = asRecord(summary.safeContext);
  const hasResolutionEvidence = [
    'sessionInvoiceId',
    'sessionInvoiceStatus',
    'latestInvoiceId',
    'latestInvoiceStatus',
    'invoiceListCount',
    'invoiceListStatuses',
  ].some((key) => safeContext[key] !== undefined && safeContext[key] !== null);

  if (!hasResolutionEvidence) {
    return null;
  }

  return {
    sessionInvoicePresent: Boolean(safeContext.sessionInvoiceId || safeContext.sessionInvoiceStatus),
    sessionInvoiceId: getAuditString(safeContext, 'sessionInvoiceId'),
    sessionInvoiceStatus: getAuditString(safeContext, 'sessionInvoiceStatus'),
    latestInvoicePresent: Boolean(safeContext.latestInvoiceId || safeContext.latestInvoiceStatus),
    latestInvoiceId: getAuditString(safeContext, 'latestInvoiceId'),
    latestInvoiceStatus: getAuditString(safeContext, 'latestInvoiceStatus'),
    invoiceListCount: getAuditNumber(safeContext, 'invoiceListCount') ?? 0,
    invoiceListStatuses: getAuditStringArray(safeContext, 'invoiceListStatuses'),
    paidInvoiceFound: false,
    reason: getAuditString(safeContext, 'reason') ?? summary.stage ?? summary.code ?? null,
  };
}

function isBlockedInvoiceResolutionAudit(metadata: Record<string, unknown>) {
  const fulfillment = asRecord(metadata.syncCheckoutSessionFulfillment);
  return fulfillment.status === 'blocked'
    && (fulfillment.reason === 'paid_invoice_missing' || fulfillment.reason === 'paid_invoice_unpaid');
}

function buildSyncCheckoutRouterFailureAudit(input: {
  stage: string;
  reason: string;
  errorSummary: ReturnType<typeof summarizePaymentError>;
  updatedAt: string;
}) {
  return {
    stage: input.stage,
    reason: input.reason,
    errorStage: input.errorSummary.stage,
    errorName: input.errorSummary.name,
    errorType: input.errorSummary.type,
    errorCode: input.errorSummary.code,
    statusCode: input.errorSummary.statusCode,
    message: input.errorSummary.message,
    updatedAt: input.updatedAt,
  };
}

async function recordSyncCheckoutFailureAudit(input: {
  supabase: any;
  session: any;
  syncInput: z.infer<typeof syncCheckoutInput>;
  stage: string;
  error: unknown;
}) {
  try {
    const now = new Date().toISOString();
    const errorSummary = summarizePaymentError(input.error);
    const invoiceResolutionAudit = buildSyncCheckoutInvoiceResolutionAudit(input.error);
    const reason = errorSummary.stage ?? errorSummary.code ?? errorSummary.message ?? 'sync_checkout_failed';

    const lookup = await input.supabase
      .from('payment_orders')
      .select('id, metadata')
      .eq('stripe_checkout_session_id', input.session.id)
      .maybeSingle();

    if (lookup.error || !lookup.data?.id) {
      logger.error('billing', 'payments_sync_checkout_audit_write_failed', {
        stage: input.stage,
        auditStage: 'lookup',
        checkoutSessionId: maskIdentifier(input.syncInput.sessionId),
        reason,
        supabaseError: lookup.error ? summarizePaymentError(lookup.error) : null,
        orderFound: Boolean(lookup.data?.id),
      });
      return;
    }

    const existingMetadata = asRecord(lookup.data.metadata);
    const routerFailure = buildSyncCheckoutRouterFailureAudit({
      stage: input.stage,
      reason,
      errorSummary,
      updatedAt: now,
    });
    const metadata = isBlockedInvoiceResolutionAudit(existingMetadata)
      ? {
          ...existingMetadata,
          lastFulfillmentError: {
            ...asRecord(existingMetadata.lastFulfillmentError),
            routerCatch: routerFailure,
          },
        }
      : {
          ...existingMetadata,
          ...(invoiceResolutionAudit ? { invoiceResolutionAudit } : {}),
          syncCheckoutSessionFulfillment: {
            status: 'failed',
            stage: input.stage,
            reason,
            checkoutStatus: input.session.status ?? null,
            paymentStatus: input.session.payment_status ?? null,
            subscriptionId: maskIdentifier(getCheckoutSessionSubscriptionId(input.session)),
            invoiceId: maskIdentifier(getCheckoutSessionInvoiceId(input.session)),
            ...(invoiceResolutionAudit ? { invoiceResolutionAudit } : {}),
            updatedAt: now,
          },
          lastFulfillmentError: routerFailure,
        };

    const update = await input.supabase
      .from('payment_orders')
      .update({
        metadata,
        updated_at: now,
      })
      .eq('id', lookup.data.id);

    if (update.error) {
      logger.error('billing', 'payments_sync_checkout_audit_write_failed', {
        stage: input.stage,
        auditStage: 'update',
        checkoutSessionId: maskIdentifier(input.syncInput.sessionId),
        orderId: maskIdentifier(lookup.data.id),
        reason,
        supabaseError: summarizePaymentError(update.error),
      });
    }
  } catch (auditError) {
    logger.error('billing', 'payments_sync_checkout_audit_write_failed', {
      stage: input.stage,
      auditStage: 'unexpected',
      checkoutSessionId: maskIdentifier(input.syncInput.sessionId),
      error: summarizePaymentError(auditError),
    });
  }
}

function toCheckoutUnavailableError() {
  return toCheckoutConfigError('支付暂不可用，请稍后重试');
}

function toItemUnavailableError(message = '该商品暂不可购买，请稍后重试') {
  return toCheckoutConfigError(message);
}

function toSubscriptionChangeUnavailableError() {
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '订阅升级状态暂无法确认，请稍后重试同一升级。' });
}

function assertPaymentPersistenceConfigured(hasSupabaseAdminPrivileges: boolean) {
  if (hasSupabaseAdminPrivileges) {
    return;
  }

  throw toCheckoutUnavailableError();
}

function throwMembershipEligibilityError(result: MembershipEligibilityResult): never {
  throw new TRPCError({
    code: result.reasonCode === 'READ_FAILED' ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
    message: result.safeMessage,
  });
}

function throwNonUpgradeEligibilityError(result: MembershipEligibilityResult): never {
  if (result.allowed && result.action === 'createCheckoutSession') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '当前套餐需要通过 Checkout 开通，不能作为订阅升级处理。',
    });
  }

  throwMembershipEligibilityError(result);
}

function getMembershipPlanPriceId(
  plan: MembershipPlanPaymentRow,
  billingCycle: MembershipBillingCycle,
) {
  return billingCycle === 'monthly'
    ? plan.stripe_monthly_price_id
    : plan.stripe_yearly_price_id;
}

function normalizeSubscriptionRows(value: unknown): StripeManagedSubscriptionRow[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean) as StripeManagedSubscriptionRow[];
  }

  return [value as StripeManagedSubscriptionRow];
}

async function loadCurrentStripeManagedSubscription(supabase: any, userId: string) {
  const result = await supabase
    .from('user_subscriptions')
    .select('id, membership_plan_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, billing_cycle, cancel_at_period_end')
    .eq('user_id', userId)
    .not('stripe_subscription_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(10);

  if (result.error) {
    throw createPaymentOperationError('读取当前订阅', result.error);
  }

  return normalizeSubscriptionRows(result.data)
    .find((subscription) => isStripeManagedSubscriptionActive({
      stripeSubscriptionId: subscription.stripe_subscription_id,
      status: subscription.status,
    })) ?? null;
}

function isUniqueConstraintViolation(error: unknown) {
  const maybeError = error as { code?: string; message?: string } | null | undefined;
  return maybeError?.code === '23505'
    || /duplicate key value violates unique constraint/i.test(maybeError?.message ?? '');
}

function toPendingSubscriptionPlanChangeError() {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: '该订阅升级正在处理中，请等待付款完成后再试。',
  });
}

async function recordSubscriptionPlanChangeOrder(input: {
  supabase: any;
  userId: string;
  plan: MembershipPlanPaymentRow;
  billingCycle: MembershipBillingCycle;
  subscription: StripeManagedSubscriptionRow;
  stripePriceId: string;
  stripeSubscription: Stripe.Subscription;
  metadata: Record<string, unknown>;
}) {
  const result = await input.supabase
    .from('payment_orders')
    .insert({
      user_id: input.userId,
      item_type: 'membership_plan',
      item_id: input.plan.id,
      billing_cycle: input.billingCycle,
      stripe_subscription_id: input.stripeSubscription.id,
      stripe_checkout_session_id: buildSubscriptionPlanChangeLockKey(input.stripeSubscription.id),
      stripe_customer_id: input.subscription.stripe_customer_id,
      stripe_price_id: input.stripePriceId,
      amount_total: null,
      currency: 'usd',
      mode: 'subscription',
      status: 'pending',
      payment_status: input.stripeSubscription.status,
      metadata: {
        ...input.metadata,
        source: 'changeSubscriptionPlan',
        previousMembershipPlanId: input.subscription.membership_plan_id,
        previousBillingCycle: input.subscription.billing_cycle,
      },
    })
    .select('id')
    .single();

  if (result.error) {
    if (isUniqueConstraintViolation(result.error)) {
      throw toPendingSubscriptionPlanChangeError();
    }

    throw createPaymentOperationError('保存订阅升级记录', result.error);
  }

  if (typeof result.data?.id !== 'string') throw toSubscriptionChangeUnavailableError();
  return result.data.id;
}

async function markSubscriptionPlanChangeOrderFailed(input: {
  supabase: any;
  orderId: string | null;
  stripeSubscriptionId: string;
}) {
  if (!input.orderId) return;

  const result = await input.supabase
    .from('payment_orders')
    .update({
      status: 'failed',
      payment_status: 'failed',
      stripe_checkout_session_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.orderId)
    .eq('stripe_subscription_id', input.stripeSubscriptionId)
    .eq('status', 'pending');

  if (result.error) {
    throw createPaymentOperationError('标记订阅升级记录失败', result.error);
  }
}

async function loadPendingSubscriptionPlanChangeOrder(
  supabase: any,
  subscriptionId: string,
): Promise<PendingUpgradeOrder[]> {
  const query = supabase
    .from('payment_orders')
    .select('id, item_id, billing_cycle, status, stripe_price_id, stripe_checkout_session_id, metadata')
    .eq('stripe_subscription_id', subscriptionId)
    .eq('item_type', 'membership_plan')
    .eq('status', 'pending')
    .order('updated_at', { ascending: false })
    .limit(10);
  const result = typeof query.then === 'function'
    ? await query
    : await query.maybeSingle();

  if (result.error) {
    throw createPaymentOperationError('读取待处理订阅升级记录', result.error);
  }

  if (Array.isArray(result.data)) {
    return result.data;
  }

  return result.data ? [result.data] : [];
}

type UpgradeAttempt = {
  quote: UpgradeQuote; originalPrice: string; itemId: string; createdAt: number;
  stripeMetadata: Record<string, string>;
};
type PendingUpgradeOrder = {
  id: string; item_id: string; billing_cycle: MembershipBillingCycle;
  stripe_price_id: string; stripe_checkout_session_id: string | null;
  metadata: Record<string, unknown> | null;
};
const renewalRestoreMessage = '已安排到期取消，请先通过订阅管理恢复续费后再升级套餐。';
function priceChangedError() {
  return new TRPCError({ code: 'CONFLICT', message: '价格或订阅状态已变化，请重新预览并确认。' });
}
function sameUpgradeQuote(a: UpgradeQuote, b: UpgradeQuote) {
  return a.amountDue === b.amountDue && a.currency === b.currency
    && a.prorationDate === b.prorationDate && a.fingerprint === b.fingerprint;
}
function upgradeAccepted() {
  return { action: 'changeSubscriptionPlan' as const, status: 'pending_fulfillment' as const };
}
function stripeObjectId(value: string | { id: string } | null | undefined) {
  return typeof value === 'string' ? value : value?.id;
}
function assertUpgradeableRemote(remote: Stripe.Subscription, local: StripeManagedSubscriptionRow, userId: string) {
  if (remote.id !== local.stripe_subscription_id || !local.stripe_customer_id
    || stripeObjectId(remote.customer) !== local.stripe_customer_id
    || (remote.metadata?.userId !== undefined && remote.metadata.userId !== userId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: '无法确认订阅归属，请联系支持。' });
  }
  if (remote.cancel_at_period_end || remote.cancel_at != null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: renewalRestoreMessage });
  }
  if (remote.status !== 'active' || remote.pending_update || remote.pause_collection || remote.schedule
    || remote.collection_method !== 'charge_automatically'
    || remote.items.has_more || remote.items.data.length !== 1
    || !remote.items.data[0]?.id || !remote.items.data[0]?.price?.id
    || remote.items.data[0].quantity !== 1) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '当前订阅暂不可升级，请先在订阅管理中确认付款和订阅状态。' });
  }
}
async function validateSubscriptionUpgrade(ctx: {
  supabase: any; supabaseAdmin: any; profileId: string; headers: Headers; hasSupabaseAdminPrivileges: boolean;
}, input: ChangeSubscriptionPlanInput) {
  assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
  const profile = await readSubscriptionChangeData<{ membership_level: string }>({
    query: ctx.supabase.from('profiles').select('membership_level').eq('id', ctx.profileId).maybeSingle(),
    changeInput: input, stage: 'profile_read', operation: '用户资料服务' });
  if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: '用户资料不存在，无法升级订阅' });
  const plan = await readSubscriptionChangeData<MembershipPlanPaymentRow>({
    query: ctx.supabase.from('membership_plans')
      .select('id, name, level, is_active, stripe_monthly_price_id, stripe_yearly_price_id, monthly_price, yearly_price')
      .eq('id', input.planId).maybeSingle(), changeInput: input, stage: 'plan_read', operation: '会员套餐服务' });
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: '会员套餐不存在' });
  const priceId = normalizeCheckoutPriceId(getMembershipPlanPriceId(plan, input.billingCycle));
  const amount = input.billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price;
  if (plan.is_active !== 'true' || plan.level === 'free' || !priceId
    || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw toItemUnavailableError();
  let eligibility: MembershipEligibilityResult;
  try {
    eligibility = await resolveMembershipEligibility({ supabase: ctx.supabase, userId: ctx.profileId,
      profile, action: 'create_membership_checkout', targetPlan: plan, targetBillingCycle: input.billingCycle });
  } catch (error) {
    logSubscriptionChangeStageFailure('eligibility_read', input, error);
    throw createSafeServiceUnavailableError(error, '会员状态暂不可用，请稍后重试');
  }
  if (eligibility.action !== 'changeSubscriptionPlan') throwNonUpgradeEligibilityError(eligibility);
  const local = await loadCurrentStripeManagedSubscription(ctx.supabase, ctx.profileId);
  if (!local?.stripe_subscription_id || !local.stripe_price_id) throw toSubscriptionChangeUnavailableError();
  if (local.cancel_at_period_end === 'true' || local.cancel_at_period_end === true) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: renewalRestoreMessage });
  }
  if (local.membership_plan_id === plan.id && local.billing_cycle === input.billingCycle) throw priceChangedError();
  const pendingOrders = await loadPendingSubscriptionPlanChangeOrder(ctx.supabase, local.stripe_subscription_id);
  const pending = pendingOrders[0];
  if (pendingOrders.length > 1 || (pending && (pending.item_id !== plan.id
    || pending.billing_cycle !== input.billingCycle || pending.stripe_price_id !== priceId
    || pending.stripe_checkout_session_id !== buildSubscriptionPlanChangeLockKey(local.stripe_subscription_id)))) {
    throw toPendingSubscriptionPlanChangeError();
  }
  const attemptSchema = z.object({ quote: upgradeQuoteSchema, originalPrice: z.string().min(1),
    itemId: z.string().min(1), createdAt: z.number().int().positive(), stripeMetadata: z.record(z.string(), z.string()) });
  const parsed = pending ? attemptSchema.safeParse(pending.metadata?.upgradeAttempt) : null;
  if (pending && !parsed?.success) throw toPendingSubscriptionPlanChangeError();
  const attempt = parsed?.success ? parsed.data : undefined;
  await assertSubscriptionChangeRateLimit(ctx.profileId, ctx.headers);
  let stripe: ReturnType<typeof getStripeClient>;
  try { stripe = getStripeClient(); } catch { throw toSubscriptionChangeUnavailableError(); }
  let remote: Stripe.Subscription;
  try { remote = await stripe.subscriptions.retrieve(local.stripe_subscription_id); }
  catch { throw toSubscriptionChangeUnavailableError(); }
  assertUpgradeableRemote(remote, local, ctx.profileId);
  const item = remote.items.data[0];
  if (item.price.id !== local.stripe_price_id && !(attempt && item.price.id === priceId)) throw priceChangedError();
  if (attempt && (attempt.itemId !== item.id || attempt.originalPrice !== local.stripe_price_id)) throw priceChangedError();
  return { stripe, remote, local, item, plan, priceId, amount, input, pending, attempt, userId: ctx.profileId };
}
type ValidatedUpgrade = Awaited<ReturnType<typeof validateSubscriptionUpgrade>>;
async function previewUpgrade(change: ValidatedUpgrade, prorationDate: number): Promise<UpgradeQuote> {
  let invoice: Stripe.Invoice;
  try {
    invoice = await change.stripe.invoices.createPreview({ customer: change.local.stripe_customer_id!,
      subscription: change.remote.id, subscription_details: {
        items: [{ id: change.item.id, price: change.priceId }],
        billing_cycle_anchor: 'now', proration_behavior: 'always_invoice', proration_date: prorationDate,
      } });
  } catch { throw toSubscriptionChangeUnavailableError(); }
  if (!Number.isSafeInteger(invoice.amount_due) || invoice.amount_due < 0 || !/^[a-z]{3}$/.test(invoice.currency)) {
    throw toSubscriptionChangeUnavailableError();
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    user: change.userId, subscription: change.remote.id, item: change.item.id, oldPrice: change.item.price.id,
    start: change.item.current_period_start, end: change.item.current_period_end,
    plan: change.plan.id, price: change.priceId, cycle: change.input.billingCycle, amount: change.amount,
    amountDue: invoice.amount_due, currency: invoice.currency, prorationDate,
  })).digest('hex');
  return { amountDue: invoice.amount_due, currency: invoice.currency, prorationDate, fingerprint };
}
async function inspectUpgradeOutcome(change: ValidatedUpgrade, orderId: string, attempt: UpgradeAttempt) {
  try {
    const remote = await change.stripe.subscriptions.retrieve(change.remote.id);
    assertUpgradeableRemote(remote, change.local, change.userId);
    const item = remote.items.data[0];
    if (item.id !== attempt.itemId) return 'unknown';
    if (item.price.id === attempt.originalPrice && remote.metadata?.upgradeAttemptId !== orderId) return 'old';
    if (item.price.id !== change.priceId || remote.metadata?.upgradeAttemptId !== orderId) return 'unknown';
    const invoiceId = stripeObjectId(remote.latest_invoice);
    if (!invoiceId) return 'unknown';
    const invoice = await change.stripe.invoices.retrieve(invoiceId);
    if (stripeObjectId(invoice.customer) !== change.local.stripe_customer_id
      || stripeObjectId(invoice.parent?.subscription_details?.subscription) !== remote.id
      || invoice.billing_reason !== 'subscription_update'
      || !['paid', 'open'].includes(invoice.status ?? '') || invoice.lines.has_more
      || !invoice.lines.data.some(line => line.pricing?.price_details?.price === change.priceId)) return 'unknown';
    return 'applied';
  } catch { return 'unknown'; }
}

async function loadPaymentItemNames(
  supabase: any,
  orders: Array<{ item_id: string; item_type: string }>
): Promise<{
  creditPackageNames: Map<string, string>;
  membershipPlanNames: Map<string, string>;
}> {
  const creditPackageIds = orders
    .filter((order) => order.item_type === 'credit_package')
    .map((order) => order.item_id);
  const membershipPlanIds = orders
    .filter((order) => order.item_type === 'membership_plan')
    .map((order) => order.item_id);

  const [creditPackagesResult, membershipPlansResult] = await Promise.all([
    creditPackageIds.length > 0
      ? supabase
          .from('credit_packages')
          .select('id, name')
          .in('id', creditPackageIds)
      : Promise.resolve({ data: [], error: null }),
    membershipPlanIds.length > 0
      ? supabase
          .from('membership_plans')
          .select('id, name')
          .in('id', membershipPlanIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (creditPackagesResult.error) {
    throw createPaymentOperationError('读取账单项目', creditPackagesResult.error);
  }

  if (membershipPlansResult.error) {
    throw createPaymentOperationError('读取账单项目', membershipPlansResult.error);
  }

  return {
    creditPackageNames: new Map<string, string>(
      (creditPackagesResult.data ?? []).map((item: { id: string; name: string }) => [item.id, item.name]),
    ),
    membershipPlanNames: new Map<string, string>(
      (membershipPlansResult.data ?? []).map((item: { id: string; name: string }) => [item.id, item.name]),
    ),
  };
}

async function loadStripeBillingDocument(stripe: ReturnType<typeof getStripeClient> | null, order: any) {
  const emptyDocument = {
    invoiceNumber: null,
    invoicePdfUrl: null,
    hostedInvoiceUrl: null,
    receiptUrl: null,
  };

  if (!stripe) {
    return emptyDocument;
  }

  try {
    if (isSubscriptionPlanChangeOrder(order)) {
      return emptyDocument;
    }

    if (order.stripe_invoice_id) {
      const invoice = await stripe.invoices.retrieve(order.stripe_invoice_id);
      return {
        invoiceNumber: invoice.number ?? null,
        invoicePdfUrl: invoice.invoice_pdf ?? null,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        receiptUrl: null,
      };
    }

    if (!order.stripe_checkout_session_id) {
      return emptyDocument;
    }

    const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id, {
      expand: ['payment_intent.latest_charge'],
    });

    const paymentIntent = typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null;
    const latestCharge = paymentIntent?.latest_charge;
    const receiptUrl =
      latestCharge && typeof latestCharge === 'object' && 'receipt_url' in latestCharge
        ? latestCharge.receipt_url ?? null
        : null;

    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl,
    };
  } catch (error) {
    logger.warn('billing', 'payments_billing_document_lookup_failed', {
      orderId: order.id,
      stripeInvoiceId: order.stripe_invoice_id ?? null,
      stripeCheckoutSessionId: order.stripe_checkout_session_id ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      invoiceNumber: null,
      invoicePdfUrl: null,
      hostedInvoiceUrl: null,
      receiptUrl: null,
    };
  }
}

function createStripeBillingDocumentLoader(stripe: ReturnType<typeof getStripeClient> | null) {
  const documentCache = new Map<string, Promise<Awaited<ReturnType<typeof loadStripeBillingDocument>>>>();

  return async (order: any) => {
    const cacheKey = order.stripe_invoice_id
      ? `invoice:${order.stripe_invoice_id}`
      : order.stripe_checkout_session_id
        ? `session:${order.stripe_checkout_session_id}`
        : `order:${order.id}`;

    const cached = documentCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = loadStripeBillingDocument(stripe, order);
    documentCache.set(cacheKey, promise);
    return promise;
  };
}

function shouldListBillingOrder(order: PaymentOrderBillingRow) {
  if (isSubscriptionPlanChangeOrder(order) && !order.stripe_invoice_id && order.amount_total == null) {
    return false;
  }

  const status = normalizePaymentOrderStatus(order.status);

  if (
    status === 'pending' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'expired' ||
    status === 'refunded' ||
    status === 'partially_refunded'
  ) {
    return true;
  }

  return Boolean(order.fulfilled_at) || order.payment_status === 'paid';
}

export const paymentsRouter = router({
  getSubscriptionManagement: protectedProcedure.query(async ({ ctx }) => {
    const subscription = await loadCurrentStripeManagedSubscription(ctx.supabase, ctx.profileId);
    return { available: Boolean(subscription?.stripe_customer_id && subscription.stripe_subscription_id) };
  }),
  createCustomerPortalSession: protectedProcedure
    .input(z.object({ returnUrl: z.string().url().optional() }).strict().optional())
    .mutation(async ({ ctx, input }) => {
      const returnUrl = getStripePortalReturnUrl(input?.returnUrl);
      assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
      const subscription = await loadCurrentStripeManagedSubscription(ctx.supabase, ctx.profileId);
      if (!subscription?.stripe_customer_id || !subscription.stripe_subscription_id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '当前没有可管理的订阅' });
      }
      try {
        const stripe = getStripeClient();
        const remote = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
        const customerId = typeof remote.customer === 'string' ? remote.customer : remote.customer.id;
        if (customerId !== subscription.stripe_customer_id
          || (remote.metadata.userId && remote.metadata.userId !== ctx.profileId)) {
          throw new Error('Portal subscription ownership mismatch');
        }
        const configurations = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
        const configuration = configurations.data[0];
        if (!configuration?.active
          || !configuration.features.subscription_cancel.enabled
          || configuration.features.subscription_cancel.mode !== 'at_period_end'
          || configuration.features.subscription_update.enabled) {
          throw new Error('Portal configuration must allow period-end cancellation and disable plan changes');
        }
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          configuration: configuration.id,
          return_url: returnUrl,
          // Scheduled cancellations go to Portal home, where the customer can
          // explicitly restore renewal. Upgrade itself never restores it.
          flow_data: remote.cancel_at_period_end || remote.cancel_at != null ? undefined : {
            type: 'subscription_cancel',
            subscription_cancel: { subscription: remote.id },
            after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
          },
        });
        return { portalUrl: session.url };
      } catch (error) {
        throw createSafeServiceUnavailableError(error, '订阅管理暂不可用，请稍后重试');
      }
    }),
  getMembershipEligibilityMatrix: protectedProcedure
    .query(async ({ ctx }) => {
      const profile = await readMembershipEligibilityData<{
        membership_level: string | null;
      }>(
        ctx.supabase
          .from('profiles')
          .select('membership_level')
          .eq('id', ctx.profileId)
          .maybeSingle(),
      );

      if (!profile) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在，无法确认会员状态',
        });
      }

      const plans = await readMembershipEligibilityData<Array<{
        id: string;
        level: string;
        is_active: string;
      }>>(
        ctx.supabase
          .from('membership_plans')
          .select('id, level, is_active')
          .eq('is_active', 'true')
          .order('sort_order', { ascending: true }),
      );

      if (!Array.isArray(plans)) {
        throw createSafeServiceUnavailableError(
          new Error('Membership eligibility catalog returned invalid data'),
          '会员状态暂不可用，请稍后重试',
        );
      }

      const billingCycles: MembershipBillingCycle[] = ['monthly', 'yearly'];
      let entries;

      try {
        entries = await Promise.all(
          plans.flatMap((plan) =>
            billingCycles.map(async (billingCycle) => {
              const eligibility = await resolveMembershipEligibility({
                supabase: ctx.supabase,
                userId: ctx.profileId,
                profile,
                action: 'create_membership_checkout',
                targetPlan: plan,
                targetBillingCycle: billingCycle,
              });

              if (eligibility.reasonCode === 'READ_FAILED') {
                throw new Error('Membership eligibility facts could not be read');
              }

              return {
                planId: plan.id,
                planLevel: plan.level,
                billingCycle,
                allowed: eligibility.allowed,
                state: eligibility.state,
                currentLevel: eligibility.level,
                action: eligibility.action,
                reasonCode: eligibility.reasonCode,
                safeMessage: eligibility.safeMessage,
              };
            }),
          ),
        );
      } catch (error) {
        throw createSafeServiceUnavailableError(
          error,
          '会员状态暂不可用，请稍后重试',
        );
      }

      return {
        currentLevel: profile.membership_level ?? 'free',
        entries,
      };
    }),
  previewSubscriptionPlanChange: protectedProcedure
    .input(changeSubscriptionPlanInput)
    .mutation(async ({ ctx, input }) => {
      const change = await validateSubscriptionUpgrade(ctx, input);
      const quote = change.attempt?.quote ?? await previewUpgrade(change, Math.floor(Date.now() / 1000));
      return { ...quote, planName: change.plan.name, planLevel: change.plan.level,
        billingCycle: input.billingCycle,
        // Catalog prices are full billed cents, not the card's monthly equivalent.
        annualAmount: input.billingCycle === 'yearly' ? change.amount : null };
    }),
  changeSubscriptionPlan: protectedProcedure
    .input(changeSubscriptionPlanInput.extend({ expected: upgradeQuoteSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      const change = await validateSubscriptionUpgrade(ctx, input);
      let orderId = change.pending?.id;
      let attempt = change.attempt;
      if (attempt) {
        if (!sameUpgradeQuote(attempt.quote, input.expected)) throw priceChangedError();
        // Always inspect remote state before recovering an existing durable attempt.
        const outcome = await inspectUpgradeOutcome(change, orderId!, attempt);
        if (outcome === 'applied') return upgradeAccepted();
        if (outcome !== 'old') throw toSubscriptionChangeUnavailableError();
        // Stripe retains idempotency keys for at least 24h. Never reapply an aged attempt.
        if (Date.now() - attempt.createdAt >= 23 * 60 * 60 * 1000) throw toSubscriptionChangeUnavailableError();
      } else {
        if (Math.abs(Math.floor(Date.now() / 1000) - input.expected.prorationDate) > 300) throw priceChangedError();
      }
      const quote = await previewUpgrade(change, input.expected.prorationDate);
      if (!sameUpgradeQuote(quote, input.expected)) throw priceChangedError();
      if (!attempt) {
        attempt = { quote, originalPrice: change.item.price.id, itemId: change.item.id,
          createdAt: Date.now(), stripeMetadata: {
            ...change.remote.metadata,
            ...buildStripeMetadata({ itemType: 'membership_plan', itemId: change.plan.id,
              userId: ctx.profileId, priceId: change.priceId, billingCycle: input.billingCycle }),
            changeSource: 'graylum_change_subscription_plan',
          } };
        orderId = await recordSubscriptionPlanChangeOrder({ supabase: ctx.supabaseAdmin,
          userId: ctx.profileId, plan: change.plan, billingCycle: input.billingCycle,
          subscription: change.local, stripePriceId: change.priceId, stripeSubscription: change.remote,
          metadata: { ...attempt.stripeMetadata, upgradeAttempt: attempt } });
      }
      try {
        await change.stripe.subscriptions.update(change.remote.id, {
          items: [{ id: attempt.itemId, price: change.priceId }],
          // Start a full target term: yearly grants require a new 12-month term.
          billing_cycle_anchor: 'now',
          proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete',
          proration_date: attempt.quote.prorationDate,
          metadata: { ...attempt.stripeMetadata, upgradeAttemptId: orderId! },
        }, { idempotencyKey: `subscription-change:${orderId}` });
      } catch (error) {
        logSubscriptionChangeStageFailure('stripe_subscription_update', input, error);
        // Only Stripe's explicit payment rejection proves error_if_incomplete did not apply.
        const rejected = error as { type?: string; statusCode?: number };
        if (rejected?.type === 'StripeCardError' && rejected.statusCode === 402) {
          await markSubscriptionPlanChangeOrderFailed({ supabase: ctx.supabaseAdmin,
            orderId: orderId!, stripeSubscriptionId: change.remote.id });
          throw new TRPCError({ code: 'BAD_REQUEST', message: '升级付款未完成，原套餐保持不变。请先在订阅管理中处理付款方式。' });
        }
        // Transport/5xx/unknown outcomes keep the lock. A later identical request can
        // recover using this SAME order/key after a fresh remote inspection.
        if (await inspectUpgradeOutcome(change, orderId!, attempt) !== 'applied') {
          throw toSubscriptionChangeUnavailableError();
        }
      }
      // Only the existing paid-invoice webhook owns plan/cycle/rights/credit admission.
      return upgradeAccepted();
    }),
  createCheckoutSession: protectedProcedure
    .input(createCheckoutInput)
    .mutation(async ({ ctx, input }) => {
      assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
      let stripe;
      try {
        assertStripeCheckoutConfigured();
        stripe = getStripeClient();
      } catch (error) {
        logCheckoutStageFailure('stripe_config', input, error);
        throw toCheckoutUnavailableError();
      }

      const profile = await readCheckoutData<{
        email: string | null;
        nickname: string | null;
        membership_level: string | null;
      }>({
        query: ctx.supabase
          .from('profiles')
          .select('email, nickname, membership_level')
          .eq('id', ctx.profileId)
          .maybeSingle(),
        checkoutInput: input,
        stage: 'profile_read',
        operation: '用户资料服务',
      });

      if (!profile) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '用户资料不存在，无法创建支付会话',
        });
      }

      let checkoutContext: {
        customerId: string;
        successUrl: string;
        cancelUrl: string;
      } | null = null;

      const getCheckoutContext = async () => {
        if (checkoutContext) {
          return checkoutContext;
        }

        await assertCheckoutRateLimit(ctx.profileId, ctx.headers);

        let customerId;
        try {
          customerId = await getOrCreateStripeCustomerId({
            supabase: ctx.supabaseAdmin,
            userId: ctx.profileId,
            email: profile.email ?? ctx.user.email ?? null,
            nickname: profile.nickname ?? null,
          });
        } catch (error) {
          logCheckoutStageFailure('customer_lookup', input, error);
          throw createPaymentOperationError('创建支付会话', error);
        }

        let appUrl;
        try {
          appUrl = getStripeAppUrl(ctx.headers);
        } catch (error) {
          logCheckoutStageFailure('checkout_url', input, error);
          throw toCheckoutUnavailableError();
        }

        checkoutContext = {
          customerId,
          successUrl: `${appUrl}/profile?tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${appUrl}/profile?tab=subscription&checkout=canceled&session_id={CHECKOUT_SESSION_ID}`,
        };

        return checkoutContext;
      };

      if (input.kind === 'credit_package') {
        const creditPackage = await readCheckoutData<{
          id: string;
          name: string;
          active: string;
          stripe_price_id: string | null;
          price: number | null;
        }>({
          query: ctx.supabase
            .from('credit_packages')
            .select('id, name, active, stripe_price_id, price')
            .eq('id', input.packageId)
            .maybeSingle(),
          checkoutInput: input,
          stage: 'package_read',
          operation: '积分包服务',
        });

        if (!creditPackage) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '积分包不存在',
          });
        }

        if (creditPackage.active !== 'true') {
          throw toCheckoutConfigError('该积分包当前未上架');
        }

        const selectedPriceId = normalizeCheckoutPriceId(creditPackage.stripe_price_id);

        if (!selectedPriceId) {
          throw toItemUnavailableError();
        }

        if (
          typeof creditPackage.price !== 'number'
          || !Number.isInteger(creditPackage.price)
          || creditPackage.price <= 0
        ) {
          throw toItemUnavailableError();
        }

        let eligibility;

        try {
          eligibility = await resolveMembershipEligibility({
            supabase: ctx.supabase,
            userId: ctx.profileId,
            profile,
            action: 'create_credit_package_checkout',
          });
        } catch (error) {
          logCheckoutStageFailure('eligibility_read', input, error);
          throw createSafeServiceUnavailableError(
            error,
            '会员状态暂不可用，请稍后重试',
          );
        }

        if (!eligibility.allowed) {
          throwMembershipEligibilityError(eligibility);
        }

        const membershipPlan =
          eligibility.level !== 'free'
            ? await readCheckoutData<{
                id: string;
                level: string;
                package_discount: number | null;
              }>({
                query: ctx.supabase
                  .from('membership_plans')
                  .select('id, level, package_discount')
                  .eq('level', eligibility.level)
                  .eq('is_active', 'true')
                  .limit(1)
                  .maybeSingle(),
                checkoutInput: input,
                stage: 'plan_discount_read',
                operation: '会员折扣服务',
                extra: {
                  priceId: maskIdentifier(selectedPriceId),
                  hasPriceId: true,
                },
              })
            : null;

        if (eligibility.level !== 'free' && !membershipPlan) {
          throw createSafeServiceUnavailableError(
            new Error('Active membership discount plan not found'),
            '会员折扣服务暂不可用，请稍后重试',
          );
        }

        const { baseAmountCents, discountedAmountCents, normalizedDiscount } =
          calculateDiscountedAmountCents({
            amountCents: creditPackage.price,
            packageDiscount: membershipPlan?.package_discount,
          });

        if (discountedAmountCents <= 0) {
          throw toItemUnavailableError();
        }

        const metadata = {
          ...buildStripeMetadata({
            itemType: 'credit_package',
            itemId: creditPackage.id,
            userId: ctx.profileId,
            priceId: selectedPriceId,
            billingCycle: 'one_time',
          }),
          membershipLevel: eligibility.level,
          packageDiscount: String(normalizedDiscount),
          basePriceCents: String(baseAmountCents),
          discountedPriceCents: String(discountedAmountCents),
        };

        const lineItems =
          discountedAmountCents === baseAmountCents
            ? [
                {
                  price: selectedPriceId,
                  quantity: 1,
                },
              ]
            : [
                {
                  price_data: {
                    currency: 'usd',
                    unit_amount: discountedAmountCents,
                    product_data: {
                      name: creditPackage.name,
                    },
                  },
                  quantity: 1,
                },
              ];

        const checkout = await getCheckoutContext();
        let session;
        try {
          session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card', 'alipay'],
            customer: checkout.customerId,
            client_reference_id: ctx.profileId,
            line_items: lineItems,
            success_url: checkout.successUrl,
            cancel_url: checkout.cancelUrl,
            metadata,
            payment_intent_data: { metadata },
          });
        } catch (error) {
          logCheckoutStageFailure('stripe_session_create', input, error, {
            priceId: maskIdentifier(selectedPriceId),
            hasPriceId: true,
          });
          throw createPaymentOperationError('创建支付会话', error);
        }

        const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
          user_id: ctx.profileId,
          item_type: 'credit_package',
          item_id: creditPackage.id,
          billing_cycle: 'one_time',
          stripe_checkout_session_id: session.id,
          stripe_customer_id: checkout.customerId,
          stripe_price_id: selectedPriceId,
          amount_total: discountedAmountCents,
          currency: 'usd',
          mode: 'payment',
          status: 'pending',
          payment_status: session.payment_status,
          metadata,
        });

        if (orderError) {
          logCheckoutStageFailure('order_insert', input, orderError, {
            priceId: maskIdentifier(selectedPriceId),
            hasPriceId: true,
          });
          throw createPaymentOperationError('保存支付订单', orderError);
        }

        if (!session.url) {
          throw createPaymentOperationError('创建支付会话', new Error('Stripe checkout URL missing'));
        }

        return {
          checkoutUrl: session.url,
          sessionId: session.id,
        };
      }

      const plan = await readCheckoutData<{
        id: string;
        name: string;
        level: string;
        is_active: string;
        stripe_monthly_price_id: string | null;
        stripe_yearly_price_id: string | null;
        monthly_price: number | null;
        yearly_price: number | null;
      }>({
        query: ctx.supabase
          .from('membership_plans')
          .select('id, name, level, is_active, stripe_monthly_price_id, stripe_yearly_price_id, monthly_price, yearly_price')
          .eq('id', input.planId)
          .maybeSingle(),
        checkoutInput: input,
        stage: 'plan_read',
        operation: '会员套餐服务',
      });

      if (!plan) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '会员套餐不存在',
        });
      }

      if (plan.is_active !== 'true') {
        throw toCheckoutConfigError('该会员套餐当前未启用');
      }

      if (plan.level === 'free') {
        throw toCheckoutConfigError('免费套餐无需创建支付会话');
      }

      const selectedPriceId = normalizeCheckoutPriceId(
        input.billingCycle === 'monthly'
          ? plan.stripe_monthly_price_id
          : plan.stripe_yearly_price_id,
      );

      if (!selectedPriceId) {
        throw toItemUnavailableError('该会员套餐暂不可购买，请稍后重试');
      }

      const selectedAmount = input.billingCycle === 'monthly'
        ? plan.monthly_price
        : plan.yearly_price;

      if (
        typeof selectedAmount !== 'number'
        || !Number.isInteger(selectedAmount)
        || selectedAmount <= 0
      ) {
        throw toItemUnavailableError('该会员套餐暂不可购买，请稍后重试');
      }

      let eligibility;

      try {
        eligibility = await resolveMembershipEligibility({
          supabase: ctx.supabase,
          userId: ctx.profileId,
          profile,
          action: 'create_membership_checkout',
          targetPlan: plan,
          targetBillingCycle: input.billingCycle,
        });
      } catch (error) {
        logCheckoutStageFailure('eligibility_read', input, error, {
          priceId: maskIdentifier(selectedPriceId),
          hasPriceId: true,
        });
        throw createSafeServiceUnavailableError(
          error,
          '会员状态暂不可用，请稍后重试',
        );
      }

      if (!eligibility.allowed) {
        throwMembershipEligibilityError(eligibility);
      }

      const metadata = buildStripeMetadata({
        itemType: 'membership_plan',
        itemId: plan.id,
        userId: ctx.profileId,
        priceId: selectedPriceId,
        billingCycle: input.billingCycle,
      });

      const checkout = await getCheckoutContext();
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          // alipay_subscription_enabled is a future placeholder, never a recurring payment switch.
          payment_method_types: ['card'],
          customer: checkout.customerId,
          client_reference_id: ctx.profileId,
          line_items: [
            {
              price: selectedPriceId,
              quantity: 1,
            },
          ],
          success_url: checkout.successUrl,
          cancel_url: checkout.cancelUrl,
          metadata,
          subscription_data: {
            metadata,
          },
        });
      } catch (error) {
        logCheckoutStageFailure('stripe_session_create', input, error, {
          priceId: maskIdentifier(selectedPriceId),
          hasPriceId: Boolean(selectedPriceId),
        });
        throw createPaymentOperationError('创建支付会话', error);
      }

      const { error: orderError } = await ctx.supabaseAdmin.from('payment_orders').insert({
        user_id: ctx.profileId,
        item_type: 'membership_plan',
        item_id: plan.id,
        billing_cycle: input.billingCycle,
        stripe_checkout_session_id: session.id,
        stripe_customer_id: checkout.customerId,
        stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : null,
        stripe_price_id: selectedPriceId,
        amount_total: selectedAmount,
        currency: 'usd',
        mode: 'subscription',
        status: 'pending',
        payment_status: session.payment_status,
        metadata,
      });

      if (orderError) {
        logCheckoutStageFailure('order_insert', input, orderError, {
          priceId: maskIdentifier(selectedPriceId),
          hasPriceId: Boolean(selectedPriceId),
        });
        throw createPaymentOperationError('保存支付订单', orderError);
      }

      if (!session.url) {
        throw createPaymentOperationError('创建支付会话', new Error('Stripe checkout URL missing'));
      }

      return {
        checkoutUrl: session.url,
        sessionId: session.id,
      };
    }),
  syncCheckoutSession: protectedProcedure
    .input(syncCheckoutInput)
    .mutation(async ({ ctx, input }) => {
      assertPaymentPersistenceConfigured(ctx.hasSupabaseAdminPrivileges);
      try {
        assertStripeCheckoutConfigured();
      } catch (error) {
        logSyncCheckoutStageFailure('stripe_config', input, error);
        throw toCheckoutUnavailableError();
      }

      const stripe = getStripeClient();
      let session;
      try {
        logSyncCheckoutStage('session_retrieve_start', input, {
          profileId: maskIdentifier(ctx.profileId),
        });
        session = await stripe.checkout.sessions.retrieve(input.sessionId, {
          expand: ['payment_intent', 'subscription', 'invoice'],
        });
        logSyncCheckoutStage('session_retrieve', input, {
          profileId: maskIdentifier(ctx.profileId),
          mode: session.mode,
          checkoutStatus: session.status,
          paymentStatus: session.payment_status,
          subscriptionId: maskIdentifier(getCheckoutSessionSubscriptionId(session)),
          invoiceId: maskIdentifier(getCheckoutSessionInvoiceId(session)),
        });
      } catch (error) {
        logSyncCheckoutStageFailure('session_retrieve', input, error, {
          profileId: maskIdentifier(ctx.profileId),
        });
        throw createPaymentOperationError('同步支付会话', error);
      }

      const sessionUserId =
        session.metadata?.userId ??
        session.client_reference_id ??
        null;

      if (sessionUserId !== ctx.profileId) {
        logSyncCheckoutStageFailure('session_owner_check', input, new Error('checkout session owner mismatch'), {
          profileId: maskIdentifier(ctx.profileId),
          sessionUserId: maskIdentifier(sessionUserId),
        });
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '你无权同步这笔支付会话',
        });
      }

      let syncStage = 'upsert_payment_order';
      let syncStageContext: Record<string, unknown> = {
        profileId: maskIdentifier(ctx.profileId),
        mode: session.mode,
        checkoutStatus: session.status,
        paymentStatus: session.payment_status,
        subscriptionId: maskIdentifier(getCheckoutSessionSubscriptionId(session)),
        invoiceId: maskIdentifier(getCheckoutSessionInvoiceId(session)),
      };

      try {
        logSyncCheckoutStage(syncStage, input, syncStageContext);
        await upsertPaymentOrderBySession(ctx.supabaseAdmin, session, isCanceledCheckoutState(input.checkoutState)
          ? {
              orderStatus: 'canceled',
              eventType: 'checkout.return.canceled',
            }
          : {
              eventType: 'checkout.session.sync',
            });

        if (isCanceledCheckoutState(input.checkoutState)) {
          syncStage = 'canceled_return_recorded';
          logSyncCheckoutStage(syncStage, input, syncStageContext);
        } else {
          if (session.mode === 'payment' && session.payment_status === 'paid') {
            syncStage = 'fulfill_credit_package';
            logSyncCheckoutStage(syncStage, input, syncStageContext);
            await fulfillCreditPackageOrder(ctx.supabaseAdmin, session);
          }

          if (session.mode === 'subscription') {
            syncStage = 'fulfill_paid_membership_checkout_session';
            logSyncCheckoutStage(syncStage, input, syncStageContext);
            const fulfillment = await fulfillPaidMembershipCheckoutSession(
              ctx.supabaseAdmin,
              stripe,
              session,
            );
            syncStageContext = {
              ...syncStageContext,
              subscriptionId: maskIdentifier(fulfillment.subscriptionId),
              invoiceId: maskIdentifier(fulfillment.invoiceId),
              fulfillmentReason: fulfillment.reason,
            };

            if (fulfillment.fulfilled) {
              logSyncCheckoutStage('fulfill_membership_invoice', input, syncStageContext);
            } else if (session.payment_status === 'paid') {
              logger.warn('billing', 'payments_sync_checkout_unfulfilled_paid_subscription', {
                stage: syncStage,
                checkoutSessionId: maskIdentifier(input.sessionId),
                subscriptionId: maskIdentifier(fulfillment.subscriptionId),
                reason: fulfillment.reason,
              });
              throw new Error('Paid subscription checkout did not complete fulfillment');
            } else if (fulfillment.reason === 'paid_invoice_missing') {
              logger.warn('billing', 'payments_sync_checkout_no_paid_invoice', {
                stage: syncStage,
                checkoutSessionId: maskIdentifier(input.sessionId),
                subscriptionId: maskIdentifier(fulfillment.subscriptionId),
              });
            }
          }
        }
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        await recordSyncCheckoutFailureAudit({
          supabase: ctx.supabaseAdmin,
          session,
          syncInput: input,
          stage: syncStage,
          error,
        });
        logSyncCheckoutStageFailure(syncStage, input, error, syncStageContext);
        throw createPaymentOperationError('同步支付会话', error);
      }

      const syncedOrderQuery = ctx.supabaseAdmin
        .from('payment_orders')
        .select('status, payment_status, fulfilled_at, stripe_subscription_id, stripe_invoice_id')
        .eq('stripe_checkout_session_id', session.id);
      const orderedSyncedOrderQuery = typeof syncedOrderQuery.order === 'function'
        ? syncedOrderQuery.order('created_at', { ascending: true })
        : syncedOrderQuery;
      const limitedSyncedOrderQuery = typeof orderedSyncedOrderQuery.limit === 'function'
        ? orderedSyncedOrderQuery.limit(10)
        : orderedSyncedOrderQuery;
      const { data: syncedOrderData, error: syncedOrderError } =
        typeof limitedSyncedOrderQuery.then === 'function'
          ? await limitedSyncedOrderQuery
          : await limitedSyncedOrderQuery.maybeSingle();

      if (syncedOrderError) {
        logSyncCheckoutStageFailure('final_order_read', input, syncedOrderError, {
          profileId: maskIdentifier(ctx.profileId),
        });
        throw createPaymentOperationError('读取支付同步结果', syncedOrderError);
      }

      const syncedOrders = Array.isArray(syncedOrderData)
        ? syncedOrderData
        : syncedOrderData
          ? [syncedOrderData]
          : [];
      const syncedOrder = syncedOrders[0] ?? null;
      if (syncedOrders.length > 1) {
        logger.warn('billing', 'payments_sync_checkout_duplicate_order_detected', {
          checkoutSessionId: maskIdentifier(session.id),
          profileId: maskIdentifier(ctx.profileId),
          orderCount: syncedOrders.length,
        });
      }

      logSyncCheckoutStage('final_order_read', input, {
        profileId: maskIdentifier(ctx.profileId),
        orderStatus: syncedOrder?.status ?? null,
        paymentStatus: syncedOrder?.payment_status ?? null,
        fulfilledAt: syncedOrder?.fulfilled_at ?? null,
        subscriptionId: maskIdentifier(syncedOrder?.stripe_subscription_id),
        invoiceId: maskIdentifier(syncedOrder?.stripe_invoice_id),
      });

      return {
        sessionId: session.id,
        mode: session.mode,
        checkoutStatus: session.status,
        paymentStatus: session.payment_status,
        orderStatus: syncedOrder?.status ? normalizePaymentOrderStatus(syncedOrder.status) : null,
        fulfilledAt: syncedOrder?.fulfilled_at ?? null,
        stripeSubscriptionId: syncedOrder?.stripe_subscription_id ?? null,
        stripeInvoiceId: syncedOrder?.stripe_invoice_id ?? null,
      };
    }),
  listBillingRecords: protectedProcedure
    .query(async ({ ctx }) => {
      const { data: orders, error } = await ctx.supabase
        .from('payment_orders')
        .select([
          'id',
          'item_id',
          'item_type',
          'billing_cycle',
          'stripe_checkout_session_id',
          'stripe_invoice_id',
          'amount_total',
          'currency',
          'status',
          'payment_status',
          'fulfilled_at',
          'created_at',
          'metadata',
        ].join(','))
        .eq('user_id', ctx.profileId)
        .order('created_at', { ascending: false });

      if (error) {
        throw createPaymentOperationError('读取账单记录', error);
      }

      const billingOrders = (orders ?? []) as unknown as PaymentOrderBillingRow[];

      const rawOrders = billingOrders.filter(shouldListBillingOrder);

      const { creditPackageNames, membershipPlanNames } = await loadPaymentItemNames(ctx.supabase, rawOrders);
      let stripe: ReturnType<typeof getStripeClient> | null = null;

      try {
        stripe = getStripeClient();
      } catch {
        stripe = null;
      }
      const loadBillingDocument = createStripeBillingDocumentLoader(stripe);

      let records;
      try {
        records = await Promise.all(
          rawOrders.map(async (order): Promise<BillingRecord> => {
            const stripeDocuments = await loadBillingDocument(order);
            const itemType: BillingRecord['itemType'] =
              order.item_type === 'membership_plan' ? 'membership_plan' : 'credit_package';
            const status: PaymentOrderStatus = normalizePaymentOrderStatus(order.status);
            const title: string = itemType === 'membership_plan'
              ? membershipPlanNames.get(order.item_id) ?? '会员订阅'
              : creditPackageNames.get(order.item_id) ?? '积分加油包';
            const billingCycle: BillingRecord['billingCycle'] = order.billing_cycle ?? 'one_time';

            return {
              id: order.id,
              itemType,
              title,
              description:
                itemType === 'membership_plan'
                  ? `订阅账单 · ${billingCycle === 'yearly' ? '年付' : '月付'}`
                  : '一次性积分购买',
              status,
              amountTotal: Number(order.amount_total ?? 0) / 100,
              currency: order.currency ?? 'usd',
              billingCycle,
              createdAt: order.created_at,
              fulfilledAt: order.fulfilled_at,
              invoiceNumber: stripeDocuments.invoiceNumber,
              invoicePdfUrl: stripeDocuments.invoicePdfUrl,
              hostedInvoiceUrl: stripeDocuments.hostedInvoiceUrl,
              receiptUrl: stripeDocuments.receiptUrl,
            };
          }),
        );
      } catch (error) {
        throw createPaymentOperationError('读取账单记录', error);
      }

      return records;
    }),
});
