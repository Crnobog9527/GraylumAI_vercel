/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { publicProcedure } from '../trpc';
import { checkRateLimitOrThrow } from '../services/redisRateLimiter';
import { getClientIp } from '../services/invitationRuntime';
import { getStripeClient, isStripeCheckoutConfigured } from '../services/stripe';
import { readPublicOffers } from '../services/payments/publicOffers';

/** Stripe only when checkout is configured; otherwise the founder offer is simply not shown. */
export function publicOffersStripe() {
  try { return isStripeCheckoutConfigured() ? getStripeClient() : null; } catch { return null; }
}

/**
 * Public, read-only offer facts (Gold first month, founder price and seats left) for pages that sign-in does not
 * gate. Rate limited per client address in the anonymous bucket; it fails closed when the limiter is unavailable.
 * The server-rendered landing page calls readPublicOffers directly instead of this HTTP route.
 */
export const getPublicOffers = publicProcedure.query(async ({ ctx }) => {
  await checkRateLimitOrThrow(`public-offers:${getClientIp(ctx.headers ?? new Headers()) ?? 'unknown'}`, 'anonymous');
  const db = ctx.hasSupabaseAdminPrivileges && ctx.supabaseAdmin ? ctx.supabaseAdmin : null;
  return readPublicOffers(db, db ? publicOffersStripe() : null);
});
