/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  CHECKOUT_COPY, cardMethods, checkoutEntryOpen, describeCheckoutError, isStripeCheckoutUrl,
  type CardMethod, type MethodPurchase,
} from './methodCheckout';

export type CheckoutOutcome = { tone: 'error' | 'recovery'; message: string; goldFirstIneligible: boolean; founderSoldOut: boolean };

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
  const inFlight = useRef(false);
  const entry = membership.data;
  const open = checkoutEntryOpen(entry);

  /** `onFounderSoldOut` runs when the server says the last founder seat just went: the caller drops to the standard price. */
  async function start(purchase: MethodPurchase, method: CardMethod, acceptedTerms: boolean, onFounderSoldOut?: () => void) {
    if (inFlight.current || redirecting || !checkoutEntryOpen(entry) || !acceptedTerms) return;
    if (!cardMethods(entry, purchase.itemType).includes(method)) return;
    inFlight.current = true;
    setOutcome(null);
    try {
      const result = await mutation.mutateAsync({ ...purchase, method, routingVersion: entry.routes.version,
        acceptedTerms: true, termsVersion: entry.termsVersion });
      if (result.state === 'open' && isStripeCheckoutUrl(result.url)) {
        setRedirecting(true);
        window.location.assign(result.url);
        return;
      }
      setOutcome({ tone: 'recovery', goldFirstIneligible: false, founderSoldOut: false,
        message: result.state === 'recovery_required' ? CHECKOUT_COPY.recovery : CHECKOUT_COPY.badUrl });
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
    start,
  };
}

export type MethodCheckout = ReturnType<typeof useMethodCheckout>;
