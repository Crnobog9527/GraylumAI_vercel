/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * A landing-page "buy" link: /profile?tab=subscription&buy=<pro|gold>&cycle=<monthly|yearly>[&offer=<offer>].
 * Only the values listed here are read; anything else is not a buy link. The link only says which plan was
 * picked: prices, the Gold first month and founder seats are still decided by the server when the checkout
 * dialog opens. A logged-out visitor is sent to sign-up with the rebuilt link as the return path
 * (Owner 2026-10-17), so nothing from the original query other than these values rides along.
 */
export const BUY_INTENT_PATH = '/app/profile';

const LEVELS = ['pro', 'gold'] as const;
const CYCLES = ['monthly', 'yearly'] as const;
// The offer kinds checkout knows (planCheckoutTarget). Kept only as a hint; the server re-checks eligibility.
const OFFERS = ['gold_first30', 'founder', 'standard'] as const;

export type BuyIntent = {
  level: (typeof LEVELS)[number];
  cycle: (typeof CYCLES)[number];
  offer?: (typeof OFFERS)[number];
};

function pick<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.find(item => item === value) ?? null;
}

export function parseBuyIntent(params: { get: (key: string) => string | null }): BuyIntent | null {
  const level = pick(LEVELS, params.get('buy'));
  const cycle = pick(CYCLES, params.get('cycle'));
  if (!level || !cycle) return null;
  const offer = pick(OFFERS, params.get('offer'));
  return offer ? { level, cycle, offer } : { level, cycle };
}

/** The membership page link for an intent, rebuilt from the allowed values only. */
export function buyIntentPath(intent: BuyIntent) {
  const params = new URLSearchParams({ tab: 'subscription', buy: intent.level, cycle: intent.cycle });
  if (intent.offer) params.set('offer', intent.offer);
  return `${BUY_INTENT_PATH}?${params.toString()}`;
}

/** The buy intent in a same-site return path (already passed through sanitizeRedirectTarget), if it is one. */
export function buyIntentFromTarget(target: string): BuyIntent | null {
  const queryIndex = target.indexOf('?');
  if (queryIndex < 0 || target.slice(0, queryIndex) !== BUY_INTENT_PATH) return null;
  const hashIndex = target.indexOf('#', queryIndex);
  return parseBuyIntent(new URLSearchParams(target.slice(queryIndex + 1, hashIndex < 0 ? undefined : hashIndex)));
}

export function describeBuyIntent(intent: BuyIntent) {
  return `${intent.level === 'gold' ? 'Gold' : 'Pro'} ${intent.cycle === 'yearly' ? '年付' : '月付'}`;
}
