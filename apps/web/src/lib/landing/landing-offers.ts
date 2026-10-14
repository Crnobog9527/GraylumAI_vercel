/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cache } from 'react';
import { createTRPCContext } from '@repo/api/src/trpc';
import { publicOffersStripe } from '@repo/api/src/routers/publicOffers';
import { readPublicOffers } from '@repo/api/src/services/payments/publicOffers';
import type { LandingOffers } from './landing-pricing';

/**
 * Switch for the $49 Gold first month and the founder card (off unless exactly "on"). The web purchase flow does not
 * carry these offers to checkout yet (PAY-STRIPE-MP step 5, card checkout frontend), so the page must not advertise
 * them before then: turn it on once buying from the landing page reaches the offer price.
 */
export const LANDING_PROMO_OFFERS_ENV = 'LANDING_PROMO_OFFERS';

/**
 * Server-side read of the public offers for pre-rendered public pages (hourly revalidation). It calls the service
 * directly, so it does not use the rate-limited HTTP route. Any failure hides the offers ({}), never guesses them.
 */
export const getLandingOffers = cache(async (): Promise<LandingOffers> => {
  if (process.env[LANDING_PROMO_OFFERS_ENV] !== 'on' || process.env.SECURITY_E2E_LOCAL_ONLY === 'true') return {};
  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const db = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin ? ctx.supabaseAdmin : null;
    const offers = await readPublicOffers(db, db ? publicOffersStripe() : null);
    return { goldFirstMonth: offers.goldFirstMonth, founder: offers.founder };
  } catch {
    return {};
  }
});
