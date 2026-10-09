/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import {
  getMembershipPlanButtonState, getPlanEligibilityKey, type MembershipPlanEligibilityEntry,
} from '@/components/profile/subscriptionPlanButtonState';
import { pickPaywallPlans, type PaywallBilling, type PaywallPlan } from './paywallPlans';

/**
 * Plans and the purchase action for a paywall. Purchase goes through the existing
 * `payments.createCheckoutSession` path and the server's eligibility answer; the paywall never
 * decides who may buy. An upgrade of an existing subscription is not started from here.
 */
export function usePaywallCheckout() {
  const plansQuery = trpc.settings.getMembershipPlans.useQuery(undefined, { staleTime: 60_000 });
  const eligibility = trpc.payments.getMembershipEligibilityMatrix.useQuery(undefined, { staleTime: 0, retry: false });
  const createCheckout = trpc.payments.createCheckoutSession.useMutation();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const plans: PaywallPlan[] = useMemo(() => pickPaywallPlans(plansQuery.data), [plansQuery.data]);
  const entries = useMemo(() => {
    const map = new Map<string, MembershipPlanEligibilityEntry>();
    for (const entry of eligibility.data?.entries ?? []) {
      if (entry.billingCycle === 'monthly' || entry.billingCycle === 'yearly') {
        map.set(getPlanEligibilityKey(entry.planId, entry.billingCycle), entry as MembershipPlanEligibilityEntry);
      }
    }
    return map;
  }, [eligibility.data]);

  function buttonState(plan: PaywallPlan, billing: PaywallBilling) {
    const state = getMembershipPlanButtonState({
      eligibility: entries.get(getPlanEligibilityKey(plan.id, billing)),
      eligibilityLoading: eligibility.isLoading,
      checkoutReady: plan.checkoutReady?.[billing] === true,
      pending: createCheckout.isPending,
    });
    if (eligibility.isError) return { ...state, disabled: true, canCreateCheckout: false, message: '暂时无法确认购买资格，请稍后再试。' };
    // Upgrading a live subscription needs its own quote and confirmation (个人中心), not this button.
    if (state.canChangeSubscriptionPlan) return { ...state, disabled: true, canCreateCheckout: false,
      message: '你已有订阅，请到个人中心的会员页升级。' };
    if (!state.canCreateCheckout && !state.message) return { ...state, disabled: true, message: '暂不可购买，请稍后再试。' };
    return { ...state, disabled: state.disabled || !state.canCreateCheckout };
  }

  // A failed catalog refetch keeps the old data; never sell from a price the server no longer confirms.
  const catalogFailed = plansQuery.isError || (!plansQuery.isLoading && plans.length === 0);

  async function startCheckout(plan: PaywallPlan, billing: PaywallBilling) {
    if (inFlight.current || catalogFailed || !buttonState(plan, billing).canCreateCheckout) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await createCheckout.mutateAsync({ kind: 'membership_plan', planId: plan.id, billingCycle: billing });
      window.location.assign(result.checkoutUrl);
    } catch (cause) {
      setError(getSafeErrorMessage(cause, '创建支付页面失败，请稍后重试。'));
    } finally {
      inFlight.current = false;
    }
  }

  return {
    plans, loading: plansQuery.isLoading, catalogFailed,
    pending: createCheckout.isPending, error, buttonState, startCheckout,
  };
}
