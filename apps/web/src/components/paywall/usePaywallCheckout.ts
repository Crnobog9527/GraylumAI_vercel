/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/trpc/client';
import { GOLD_FIRST_MONTH_USD, GOLD_FOUNDER_YEAR_USD, founderSeatsLeft, type MethodPurchase } from './methodCheckout';
import { useMethodCheckout } from './useMethodCheckout';
import { pickPaywallPlans, type PaywallBilling, type PaywallPlan, type PaywallQuoteOptions } from './paywallPlans';

/**
 * Plans and the card purchase for a paywall (`payments.methodCheckout`). The server answers who
 * may buy and at which offer; the paywall only shows the Gold first month when the server says the
 * account is eligible, and drops it for the standard price after the server refuses it. The founder Gold
 * yearly price shows while the server reports seats left; a sold-out answer at checkout drops to standard.
 */
export function usePaywallCheckout() {
  const plansQuery = trpc.settings.getMembershipPlans.useQuery(undefined, { staleTime: 60_000 });
  const method = useMethodCheckout();
  const [firstMonthDeclined, setFirstMonthDeclined] = useState(false);
  // Set when checkout answered "founder seats sold out": the standard yearly price applies from then on.
  const [founderSoldOut, setFounderSoldOut] = useState(false);
  // Set when the server said this account cannot take the founder price (an earlier founder order).
  const [founderDeclined, setFounderDeclined] = useState(false);

  const plans: PaywallPlan[] = useMemo(() => pickPaywallPlans(plansQuery.data), [plansQuery.data]);
  // A failed catalog refetch keeps the old data; never sell from a price the server no longer confirms.
  const catalogFailed = plansQuery.isError || (!plansQuery.isLoading && plans.length === 0);
  const goldFirstMonth = method.entry?.goldFirstMonthEligible === true && !firstMonthDeclined;
  const founderSeats = founderSoldOut || founderDeclined ? 0 : founderSeatsLeft(method.entry);
  const quoteOptions: PaywallQuoteOptions = { goldFirstMonthUsd: goldFirstMonth ? GOLD_FIRST_MONTH_USD : null,
    founderUsd: founderSeats > 0 ? GOLD_FOUNDER_YEAR_USD : null };

  function purchaseFor(plan: PaywallPlan, billing: PaywallBilling): MethodPurchase | null {
    if (catalogFailed || plan.checkoutReady?.[billing] !== true) return null;
    const gold = plan.level === 'gold';
    const offer = goldFirstMonth && gold && billing === 'monthly' ? 'gold_first30'
      : founderSeats > 0 && gold && billing === 'yearly' ? 'founder' : 'standard';
    return { itemType: 'membership_plan', itemId: plan.id, billingCycle: billing, offer };
  }

  return {
    plans, loading: plansQuery.isLoading, catalogFailed, method, quoteOptions, purchaseFor, founderSeats, founderSoldOut,
    declineFirstMonth: () => setFirstMonthDeclined(true),
    markFounderSoldOut: () => setFounderSoldOut(true),
    declineFounder: () => setFounderDeclined(true),
  };
}
