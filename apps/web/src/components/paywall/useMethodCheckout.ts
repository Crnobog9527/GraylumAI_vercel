/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { checkoutAnalyticsIds, reportBeginCheckout } from '@/lib/analytics/events';
import { trpc } from '@/trpc/client';
import {
  CHECKOUT_COPY, checkoutMethods, checkoutEntryOpen, describeCheckoutError, isMethodCheckoutUrl,
  type CheckoutMethod, type MethodPurchase,
} from './methodCheckout';

export type CheckoutOutcome = {
  tone: 'error' | 'recovery'; message: string; goldFirstIneligible: boolean; founderSoldOut: boolean; founderIneligible: boolean;
};

/**
 * Membership entry and the purchase action (`payments.methodCheckout`). One in-flight request
 * at a time; after a hand-off to the payment provider the button stays disabled. A `recovery_required` answer is
 * never retried here: the user is sent to billing records so the same order is not bought twice.
 */
export function useMethodCheckout() {
  const membership = trpc.payments.methodMembership.useQuery(undefined, { staleTime: 0, retry: false });
  const mutation = trpc.payments.methodCheckout.useMutation();
  const [outcome, setOutcome] = useState<CheckoutOutcome | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  // Purchases answered with recovery_required (or an address we refused): never offered again in this page's life,
  // even after the dialog is closed and reopened, so the same order cannot be bought twice.
  const [locked, setLocked] = useState<ReadonlyMap<string, string>>(new Map());
  const inFlight = useRef(false);
  const entry = membership.data;
  const open = checkoutEntryOpen(entry);

  /** `acceptedTermsVersion` is the terms version the user ticked; nothing is sent unless it is still the published one.
   * `onFounderSoldOut` runs when the server says the last founder seat just went: the caller drops to the standard price. */
  async function start(purchase: MethodPurchase, method: CheckoutMethod, acceptedTermsVersion: string | null,
    onFounderSoldOut?: () => void) {
    if (inFlight.current || redirecting || !checkoutEntryOpen(entry) || !acceptedTermsVersion
      || acceptedTermsVersion !== entry.termsVersion) return;
    if (!checkoutMethods(entry, purchase.itemType, purchase.billingCycle).includes(method) || locked.has(purchaseLockKey(purchase))) return;
    if (purchase.transition === 'wallet_renewal' && entry.purchaseChannel !== 'waffo' && method !== 'wechat_pay' && method !== 'alipay') return;
    inFlight.current = true;
    setOutcome(null);
    try {
      // GA ids only with statistics consent (ANALYTICS §3.1); the server keeps them beside the order, never in it.
      const analytics = await checkoutAnalyticsIds();
      const customerId = new URLSearchParams(window.location.search).get('stripe_test_clock_customer');
      const stripeTestClockCustomerId = customerId && /^cus_[A-Za-z0-9]{6,128}$/.test(customerId) ? customerId : undefined;
      const result = await mutation.mutateAsync({ ...purchase, method, routingVersion: entry.routes.version,
        acceptedTerms: true, termsVersion: acceptedTermsVersion,
        ...(stripeTestClockCustomerId ? { stripeTestClockCustomerId } : {}), ...(analytics ? { analytics } : {}) });
      if (result.state === 'open' && isMethodCheckoutUrl(result.url, entry.purchaseChannel)) {
        setRedirecting(true);
        // Statistics only (catalog item and pre-tax value, no order ID); a no-op without consent.
        reportBeginCheckout(purchase.itemId, 'checkoutValue' in result ? result.checkoutValue ?? null : null);
        window.location.assign(result.url);
        return;
      }
      const message = result.state === 'recovery_required' ? CHECKOUT_COPY.recovery : CHECKOUT_COPY.badUrl;
      setLocked(previous => new Map(previous).set(purchaseLockKey(purchase), message));
      setOutcome({ tone: 'recovery', goldFirstIneligible: false, founderSoldOut: false, founderIneligible: false, message });
    } catch (error) {
      const refusal = describeCheckoutError(error);
      if (refusal.founderSoldOut && onFounderSoldOut) {
        onFounderSoldOut();
        return;
      }
      setOutcome({ tone: 'error', ...refusal });
    } finally {
      inFlight.current = false;
    }
  }

  return {
    entry, open, loading: membership.isLoading, failed: membership.isError,
    pending: mutation.isPending || redirecting, outcome, clearOutcome: () => setOutcome(null),
    methodsFor: (itemType: MethodPurchase['itemType'], billingCycle?: MethodPurchase['billingCycle']) =>
      checkoutMethods(entry, itemType, billingCycle),
    lockedMessage: (purchase: MethodPurchase | null) => (purchase ? locked.get(purchaseLockKey(purchase)) ?? null : null),
    start,
  };
}

export type MethodCheckout = ReturnType<typeof useMethodCheckout>;

/** The same item, cycle and transition is the same order to the server, whatever the offer. */
function purchaseLockKey(purchase: MethodPurchase) {
  return [purchase.itemType, purchase.itemId, purchase.billingCycle, purchase.transition ?? '', purchase.priorSubscriptionId ?? ''].join('|');
}
