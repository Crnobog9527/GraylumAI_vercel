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

/** Test-only card admission, checked before any settings, order or provider access: a staging
 * deployment with the Waffo test client explicitly enabled. Production is closed whatever its
 * configuration says. The default-off server switch is `payment_method_routes.card.enabled`,
 * enforced by assertPaymentMethodRoute together with the route version. */
export function methodCheckoutEnvironmentOpen(env: Env, method: PaymentMethod) {
  if (method !== 'card') return WALLET_CHECKOUT_READY;
  return env.VERCEL === '1' && STAGING_PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '')
    && env.WAFFO_TEST_OPERATIONS_ENABLED === 'true';
}

export function assertMethodCheckoutEnvironment(env: Env, method: PaymentMethod) {
  if (!methodCheckoutEnvironmentOpen(env, method)) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
}

/** Member-page projection; the checkout mutation re-checks the same conditions. */
export function methodCardCheckoutReady(env: Env, routes: PaymentMethodRoutes | null) {
  return methodCheckoutEnvironmentOpen(env, 'card') && routes?.card.enabled === true;
}
