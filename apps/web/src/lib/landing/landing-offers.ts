/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cache } from 'react';
import { createTRPCContext } from '@repo/api/src/trpc';
import { publicOffersStripe } from '@repo/api/src/routers/publicOffers';
import { readPublicOffers } from '@repo/api/src/services/payments/publicOffers';
import type { LandingOffers } from './landing-pricing';

/**
 * Server-side read of the public offers for pre-rendered public pages (hourly revalidation). It calls the service
 * directly, so it does not use the rate-limited HTTP route. Any failure hides the offers ({}), never guesses them.
 */
export const getLandingOffers = cache(async (): Promise<LandingOffers> => {
  if (process.env.SECURITY_E2E_LOCAL_ONLY === 'true') return {};
  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const db = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin ? ctx.supabaseAdmin : null;
    const offers = await readPublicOffers(db, db ? publicOffersStripe() : null);
    return { goldFirstMonth: offers.goldFirstMonth, founder: offers.founder };
  } catch {
    return {};
  }
});
