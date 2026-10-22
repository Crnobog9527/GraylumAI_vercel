/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { logger } from '../../lib/logger';
import { paymentDeploymentMode } from './methodCheckoutGate';

/**
 * Public offer facts for the landing and pricing pages (MASTER_PLAN 2.1 item 51 and the 2026-10-10/12 decisions):
 * the Gold first month and the founder membership. The authoritative rules are in the checkout function
 * (0222 `cents:=4900`, `cents:=49600`, founder sold out at 50); publicOffers.test.ts pins these values to the newest
 * migration defining it, so a rule change there fails the test until this module follows.
 */
export const GOLD_FIRST_MONTH_CENTS = 4900;
export const FOUNDER_PRICE_CENTS = 49600;
export const FOUNDER_SEATS_TOTAL = 50;

/** Dollars, as the landing cards format them. Nothing about any user or order is ever returned. */
export type PublicOffers = {
  goldFirstMonth: number;
  founder: { price: number; total: number; available: number } | null;
};

type OffersDb = Pick<SupabaseClient, 'from'>;
type ScopeStripe = Pick<Stripe, 'accounts' | 'balance'>;

const CACHE_MS = 60_000;
let cached: { at: number; mode: 'test' | 'live'; value: PublicOffers } | undefined;

/**
 * Seats held exactly as the checkout function counts them: founder orders of the authenticated Stripe scope's mode
 * that are reserved, sold, or in open review. Any failure hides the founder offer (null) instead of guessing a number.
 */
async function founderSeats(db: OffersDb | null, mode: 'test' | 'live') {
  if (!db) return null;
  try {
    const held = await db.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('payment_mode', mode).eq('offer_kind', 'founder')
      .or('qualification_state.in.(reserved,sold),and(qualification_state.eq.review,qualification_closed_ref.is.null)');
    if (held.error || typeof held.count !== 'number') throw new Error('PUBLIC_OFFERS_COUNT_FAILED');
    return { price: FOUNDER_PRICE_CENTS / 100, total: FOUNDER_SEATS_TOTAL,
      available: Math.max(0, FOUNDER_SEATS_TOTAL - held.count) };
  } catch {
    logger.warn('billing', 'public_offers_founder_unavailable');
    return null;
  }
}

/** Cached for a minute per instance: the public numbers never need per-request precision. */
export async function readPublicOffers(db: OffersDb | null, _stripe: ScopeStripe | null, now = Date.now(),
  env: Record<string, string | undefined> = process.env): Promise<PublicOffers> {
  const mode = paymentDeploymentMode(env);
  if (cached && cached.mode === mode && now - cached.at < CACHE_MS) return cached.value;
  const value: PublicOffers = { goldFirstMonth: GOLD_FIRST_MONTH_CENTS / 100, founder: await founderSeats(db, mode) };
  // A missing founder answer is not cached, so the next request tries again.
  if (value.founder) cached = { at: now, mode, value };
  return value;
}

/** Test-only reset of the per-instance cache. */
export function resetPublicOffersCache() {
  cached = undefined;
}
