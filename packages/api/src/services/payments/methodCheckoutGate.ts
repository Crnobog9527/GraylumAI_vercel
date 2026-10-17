/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PaymentMethod, PaymentMethodRoutes } from './methodRouting';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';

type Env = Record<string, string | undefined>;

/** The staging deployment itself, bound the same way as the runtime staging check: the staging project's custom
 * domain, its project id, the `staging` branch of this repository and the staging database. A preview of the staging
 * project (same domain variable, another branch) or any other project, including production, never matches. */
function stagingDeployment(env: Env) {
  try { stagingRuntimeWindow(env, true); return true; } catch { return false; }
}

/** R7: exact production domains of the production Vercel project, the same set RUNTIME-PROD (R5) admits. */
const PRODUCTION_URLS: ReadonlySet<string> = new Set(['app.graylum.com', 'www.graylum.com']);
const STAGING_KEYS = ['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID',
  'V3_RUNTIME_STAGING_DATABASE_HOST', 'V3_RUNTIME_STAGING_WINDOW_ID'] as const;

/** The production deployment itself, bound with the R5 variables: the production project id, a Vercel production
 * build of `main` in this repository on an exact domain, the production database host, and no staging variable at all
 * (no mixed configuration). Previews, staging and any other project never match. */
function productionDeployment(env: Env) {
  if (!env.V3_RUNTIME_PRODUCTION_PROJECT_ID || !env.V3_RUNTIME_PRODUCTION_DATABASE_HOST) return false;
  if (STAGING_KEYS.some(key => env[key] !== undefined) || env.VERCEL !== '1' || env.VERCEL_ENV !== 'production'
    || !PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '') || env.VERCEL_GIT_COMMIT_REF !== 'main'
    || env.VERCEL_GIT_REPO_OWNER !== 'Crnobog9527' || env.VERCEL_GIT_REPO_SLUG !== 'GraylumAI_vercel'
    || env.VERCEL_PROJECT_ID !== env.V3_RUNTIME_PRODUCTION_PROJECT_ID) return false;
  let url: URL;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? ''); } catch { return false; }
  return url.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    && url.hostname === env.V3_RUNTIME_PRODUCTION_DATABASE_HOST && !url.username && !url.password && !url.port
    && url.pathname === '/' && !url.search && !url.hash;
}

/** Hard guard (R7 review P1): the checkout path behind this gate (methodPayments paymentMode, createStripeMethodCheckout
 * scope, methodMembership mode, database functions) is still test-only. Until R7 PR-B wires live mode through all of it,
 * production stays closed here even with the bound deployment and a switch set to `true`. PR-B flips this to `true` and
 * updates the test. Staging is not affected. */
export const LIVE_PAYMENT_PIPELINE_READY = false;

/** Stripe card checkout (PAY-STRIPE-MP 3c, "打开银行卡下单"). Staging: open on the staging deployment, behind the
 * default-off server switch `payment_method_routes.card.enabled` / `card_cn.enabled` (the controller turns it on).
 * Production (R7): open only on the bound production deployment while PAY_PRODUCTION_CARD_CHECKOUT_ENABLED is exactly
 * `true`; that variable is set only after the Owner approves opening production card checkout, never in code. Waffo
 * takes no new card purchases (Owner 2026-10-12). */
function cardCheckoutEnvironmentOpen(env: Env, liveReady: boolean) {
  if (stagingDeployment(env)) return true;
  return liveReady && productionDeployment(env) && env.PAY_PRODUCTION_CARD_CHECKOUT_ENABLED === 'true';
}

/** Stripe wallet purchases (WeChat Pay, Alipay) through the method checkout. Staging stays closed as before; they
 * never follow the card switch. Production (R7): only the bound production deployment, behind its own default-off
 * switch PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED (set only after the Owner approves). */
function walletCheckoutEnvironmentOpen(env: Env, liveReady: boolean) {
  return liveReady && productionDeployment(env) && env.PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED === 'true';
}

/** Card and wallet admission, checked before any settings, order or provider access. The server switches
 * `payment_method_routes.<method>.enabled` are enforced separately by assertPaymentMethodRoute with the route version. */
export function methodCheckoutEnvironmentOpen(env: Env, method: PaymentMethod, liveReady = LIVE_PAYMENT_PIPELINE_READY) {
  return method === 'card' || method === 'card_cn' ? cardCheckoutEnvironmentOpen(env, liveReady) : walletCheckoutEnvironmentOpen(env, liveReady);
}

export function assertMethodCheckoutEnvironment(env: Env, method: PaymentMethod, liveReady = LIVE_PAYMENT_PIPELINE_READY) {
  if (!methodCheckoutEnvironmentOpen(env, method, liveReady)) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
}

/** Member-page projection: open when either card route is on (`routes` tells which one); the checkout mutation
 * re-checks the same conditions for the method actually chosen. */
export function methodCardCheckoutReady(env: Env, routes: PaymentMethodRoutes | null, liveReady = LIVE_PAYMENT_PIPELINE_READY) {
  return methodCheckoutEnvironmentOpen(env, 'card', liveReady) && (routes?.card.enabled === true || routes?.card_cn?.enabled === true);
}
