/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export const SUBSCRIPTION_PLAN_CHANGE_LOCK_PREFIX = 'change_subscription_plan_lock:';

export function buildSubscriptionPlanChangeLockKey(subscriptionId: string) {
  return `${SUBSCRIPTION_PLAN_CHANGE_LOCK_PREFIX}${subscriptionId}`;
}

export function isSubscriptionPlanChangeLockKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SUBSCRIPTION_PLAN_CHANGE_LOCK_PREFIX);
}

export function isSubscriptionPlanChangeOrder(order: {
  metadata?: Record<string, unknown> | null;
  stripe_checkout_session_id?: string | null;
} | null | undefined) {
  return order?.metadata?.source === 'changeSubscriptionPlan'
    || isSubscriptionPlanChangeLockKey(order?.stripe_checkout_session_id);
}
