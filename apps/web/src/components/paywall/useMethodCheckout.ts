/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { reportBeginCheckout } from '@/lib/analytics/events';
import { trpc } from '@/trpc/client';
import {
  CHECKOUT_COPY, cardMethods, checkoutEntryOpen, describeCheckoutError, isStripeCheckoutUrl,
  type CardMethod, type MethodPurchase,
} from './methodCheckout';

export type CheckoutOutcome = {
  tone: 'error' | 'recovery'; message: string; goldFirstIneligible: boolean; founderSoldOut: boolean; founderIneligible: boolean;
};

/**
 * Membership entry and the card purchase action (`payments.methodCheckout`). One in-flight request
 * at a time; after a hand-off to Stripe the button stays disabled. A `recovery_required` answer is
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
  async function start(purchase: MethodPurchase, method: CardMethod, acceptedTermsVersion: string | null,
    onFounderSoldOut?: () => void) {
    if (inFlight.current || redirecting || !checkoutEntryOpen(entry) || !acceptedTermsVersion
      || acceptedTermsVersion !== entry.termsVersion) return;
    if (!cardMethods(entry, purchase.itemType).includes(method) || locked.has(purchaseLockKey(purchase))) return;
    inFlight.current = true;
    setOutcome(null);
    try {
      const result = await mutation.mutateAsync({ ...purchase, method, routingVersion: entry.routes.version,
        acceptedTerms: true, termsVersion: acceptedTermsVersion });
      if (result.state === 'open' && isStripeCheckoutUrl(result.url)) {
        setRedirecting(true);
        // Statistics only (no order ID); a no-op without consent, and it never delays the hand-off.
        reportBeginCheckout(purchase);
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
    methodsFor: (itemType: MethodPurchase['itemType']) => cardMethods(entry, itemType),
    lockedMessage: (purchase: MethodPurchase | null) => (purchase ? locked.get(purchaseLockKey(purchase)) ?? null : null),
    start,
  };
}

export type MethodCheckout = ReturnType<typeof useMethodCheckout>;

/** The same item, cycle and transition is the same order to the server, whatever the offer. */
function purchaseLockKey(purchase: MethodPurchase) {
  return [purchase.itemType, purchase.itemId, purchase.billingCycle, purchase.transition ?? '', purchase.priorSubscriptionId ?? ''].join('|');
}
