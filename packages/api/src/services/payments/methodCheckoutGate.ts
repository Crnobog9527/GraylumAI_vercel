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

/** Exact domains of the production Vercel project, same list as the RUNTIME-PROD binding (app today, www after the
 * PUBLIC-SITE domain merge). Exact match only: a new domain needs a code change. */
const PRODUCTION_URLS: ReadonlySet<string> = new Set(['app.graylum.com', 'www.graylum.com']);
const STAGING_KEYS = ['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID',
  'V3_RUNTIME_STAGING_DATABASE_HOST', 'V3_RUNTIME_STAGING_WINDOW_ID'] as const;

/** The production deployment itself, bound like RUNTIME-PROD (R5): Vercel production deployment of `main` in this
 * repository, the configured production project id and database host, an exact domain, and no staging variable at
 * all. Anything else, including a preview or the staging project, never matches. */
function productionDeployment(env: Env) {
  if (!env.V3_RUNTIME_PRODUCTION_PROJECT_ID || !env.V3_RUNTIME_PRODUCTION_DATABASE_HOST) return false;
  if (STAGING_KEYS.some(key => env[key] !== undefined) || env.VERCEL !== '1' || env.VERCEL_ENV !== 'production'
    || !PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '') || env.VERCEL_GIT_COMMIT_REF !== 'main'
    || env.VERCEL_GIT_REPO_OWNER !== 'Crnobog9527' || env.VERCEL_GIT_REPO_SLUG !== 'GraylumAI_vercel'
    || env.VERCEL_PROJECT_ID !== env.V3_RUNTIME_PRODUCTION_PROJECT_ID) return false;
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    return url.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
      && url.hostname === env.V3_RUNTIME_PRODUCTION_DATABASE_HOST && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

/** Stripe card checkout (PAY-STRIPE-MP 3c): the code is ready (checkout, first payment, renewals, external refunds,
 * daily Stripe backstop). It opens on the staging deployment, and on the bound production deployment only when the
 * default-off environment switch `PAYMENT_CARD_CHECKOUT_PRODUCTION_ENABLED=true` is set (Owner approval; the value
 * only reaches new deployments). Either way the default-off server switch `payment_method_routes.card.enabled` /
 * `card_cn.enabled` still decides, enforced by assertPaymentMethodRoute together with the route version. Waffo takes
 * no new card purchases (Owner 2026-10-12). */
const STRIPE_CARD_CHECKOUT_READY = true;

/** Stripe wallet purchases (WeChat Pay / Alipay) stay closed on staging; they open on the bound production deployment
 * only with their own switch `PAYMENT_WALLET_CHECKOUT_PRODUCTION_ENABLED=true`, never following the card switch. */
export function methodCheckoutEnvironmentOpen(env: Env, method: PaymentMethod) {
  if (method !== 'card' && method !== 'card_cn')
    return env.PAYMENT_WALLET_CHECKOUT_PRODUCTION_ENABLED === 'true' && productionDeployment(env);
  return STRIPE_CARD_CHECKOUT_READY && (stagingDeployment(env)
    || (env.PAYMENT_CARD_CHECKOUT_PRODUCTION_ENABLED === 'true' && productionDeployment(env)));
}

export function assertMethodCheckoutEnvironment(env: Env, method: PaymentMethod) {
  if (!methodCheckoutEnvironmentOpen(env, method)) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
}

/** Member-page projection: open when either card route is on (`routes` tells which one); the checkout mutation
 * re-checks the same conditions for the method actually chosen. */
export function methodCardCheckoutReady(env: Env, routes: PaymentMethodRoutes | null) {
  return methodCheckoutEnvironmentOpen(env, 'card') && (routes?.card.enabled === true || routes?.card_cn?.enabled === true);
}
