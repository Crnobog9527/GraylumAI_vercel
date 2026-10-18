/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaywallPlanSource } from '@/components/paywall/paywallPlans';
import type { LandingOffers } from '@/lib/landing/landing-pricing';

/**
 * Local preview only: when a development server cannot read the plan catalog (no database on this machine), the
 * landing samples show these fixed sample prices instead, so the price section can be reviewed. The numbers are the
 * paywall's final ones (docs/launch/design/paywall, v25): Pro $29/$279, Gold $69/$621, Gold first month $49, founder
 * $496/year; the seat count is made up. Never used outside NODE_ENV "development", and never when real data exists.
 */
export const LOCAL_SAMPLE_PLANS: readonly PaywallPlanSource[] = [
  { id: 'local-sample-pro', name: 'Pro', level: 'pro', price: { monthly: 29, yearly: 279 },
    credits: { monthly: 3480, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true } },
  { id: 'local-sample-gold', name: 'Gold', level: 'gold', price: { monthly: 69, yearly: 621 },
    credits: { monthly: 8970, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true } },
];
export const LOCAL_SAMPLE_OFFERS: LandingOffers = { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } };

export function withLocalSamplePricing(env: { NODE_ENV?: string }, plans: readonly PaywallPlanSource[], offers: LandingOffers) {
  if (env.NODE_ENV !== 'development' || plans.length > 0) return { plans, offers, sample: false };
  return { plans: LOCAL_SAMPLE_PLANS, offers: LOCAL_SAMPLE_OFFERS, sample: true };
}
