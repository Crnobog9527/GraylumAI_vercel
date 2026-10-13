/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaymentMethod, PaymentMethodRoutes } from './methodRouting';

type Env = Record<string, string | undefined>;

/** Exact custom domain of the separate staging Vercel project (same value the runtime staging
 * check uses). Staging deploys with Vercel's production class, so VERCEL_ENV cannot tell it from
 * the public site; any other project, including production, never matches. */
const STAGING_PRODUCTION_URLS: ReadonlySet<string> = new Set(['auth-staging.graylum.com']);

/** Stripe wallet purchases through the new method checkout stay closed in code; opening them is a
 * separate decision and must not follow the card test switch. */
const WALLET_CHECKOUT_READY = false;

/** Stripe card checkout (PAY-STRIPE-MP 3c, "打开银行卡下单"): the code is ready (checkout, first payment, renewals,
 * external refunds, daily Stripe backstop). It still opens on the staging deployment only, and there only while the
 * default-off server switch `payment_method_routes.card.enabled` / `card_cn.enabled` is on (the controller turns it
 * on). Production stays closed in code below until the Owner approves opening it. Waffo takes no new card purchases
 * (Owner 2026-10-12). */
const STRIPE_CARD_CHECKOUT_READY = true;

/** Test-only card admission, checked before any settings, order or provider access: the staging
 * deployment only. Production is closed whatever its configuration says. The default-off server
 * switches are `payment_method_routes.card.enabled` / `card_cn.enabled`, enforced by
 * assertPaymentMethodRoute together with the route version. */
export function methodCheckoutEnvironmentOpen(env: Env, method: PaymentMethod) {
  if (method !== 'card' && method !== 'card_cn') return WALLET_CHECKOUT_READY;
  return STRIPE_CARD_CHECKOUT_READY && env.VERCEL === '1'
    && STAGING_PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '');
}

export function assertMethodCheckoutEnvironment(env: Env, method: PaymentMethod) {
  if (!methodCheckoutEnvironmentOpen(env, method)) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
}

/** Member-page projection; the checkout mutation re-checks the same conditions. */
export function methodCardCheckoutReady(env: Env, routes: PaymentMethodRoutes | null) {
  return methodCheckoutEnvironmentOpen(env, 'card') && routes?.card.enabled === true;
}
