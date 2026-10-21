/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { newPurchaseChannel, type PaymentMethod, type PaymentMethodRoutes } from './methodRouting';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';

type Env = Record<string, string | undefined>;

/** The staging deployment itself, bound the same way as the runtime staging check: the staging project's custom
 * domain, its project id, the `staging` branch of this repository and the staging database. A preview of the staging
 * project (same domain variable, another branch) or any other project, including production, never matches. */
function stagingDeployment(env: Env) {
  try { stagingRuntimeWindow(env, true); return true; } catch { return false; }
}

/** Shared exact-bound staging predicate for staging-only checkout projections. */
export function isStagingPaymentDeployment(env: Env) { return stagingDeployment(env); }

/** R7: exact production domains of the production Vercel project, the same set RUNTIME-PROD (R5) admits. */
const PRODUCTION_URLS: ReadonlySet<string> = new Set(['app.graylum.com', 'www.graylum.com']);
const STAGING_KEYS = ['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID',
  'V3_RUNTIME_STAGING_DATABASE_HOST', 'V3_RUNTIME_STAGING_WINDOW_ID'] as const;
const STAGING_VERCEL_PROJECT_ID = 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC';
/** Narrow test-only path for the staging project's production deployment. The exact staging project, domain, branch,
 * repo and database are required so the public production project can never enable this entry. */
export function stripeTestClockStagingOpen(env: Env) {
  if (env.STRIPE_TEST_CLOCK_CHECKOUT_ENABLED !== 'true' || env.VERCEL_ENV !== 'production'
    || env.VERCEL_PROJECT_ID !== STAGING_VERCEL_PROJECT_ID || env.V3_RUNTIME_STAGING_ENABLED !== 'true') return false;
  return stagingDeployment(env);
}

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

/** Display facts must remain available when Stripe is unavailable. The deployment binding,
 * shared by admission, determines which isolated ledger is shown without a provider request. */
export function paymentDeploymentMode(env: Env = process.env): 'test' | 'live' {
  return productionDeployment(env) ? 'live' : 'test';
}

export function assertWaffoWebhookEnvironment(env: Env = process.env) {
  if (!productionDeployment(env) && !(stagingDeployment(env) && env.WAFFO_TEST_OPERATIONS_ENABLED === 'true')) {
    throw new Error('PAY_WAFFO_STEP2_NOT_READY');
  }
}

export function assertWaffoCheckoutEnvironment(env: Env, method: PaymentMethod) {
  if (method === 'wechat_pay' || !methodCheckoutEnvironmentOpen(env, method)
    || (!productionDeployment(env) && !stagingDeployment(env))
    || (stagingDeployment(env) && (method === 'alipay' || env.WAFFO_TEST_OPERATIONS_ENABLED !== 'true'))) {
    throw new Error('PAY_WAFFO_STEP2_NOT_READY');
  }
}

/** Hard guard (R7 review P1): production stays closed here until the checkout, fulfilment, renewal, entitlement and
 * refund paths run in the Stripe account's live mode. R7 PR-B1/B2/B3 (0296/0297/0298) wired them, so the marker is on;
 * opening production still needs the bound deployment and a switch set to `true` (Owner approval). Staging is not
 * affected. */
export const LIVE_PAYMENT_PIPELINE_READY = true;

/** Stripe card checkout (PAY-STRIPE-MP 3c, "打开银行卡下单"). Staging: open on the staging deployment, behind the
 * default-off server switch `payment_method_routes.card.enabled` / `card_cn.enabled` (the controller turns it on).
 * Production (R7): open only on the bound production deployment while PAY_PRODUCTION_CARD_CHECKOUT_ENABLED is exactly
 * `true`; that variable is set only after the Owner approves opening production card checkout, never in code. Waffo
 * takes no new card purchases (Owner 2026-10-12). */
function cardCheckoutEnvironmentOpen(env: Env, liveReady: boolean) {
  if (stagingDeployment(env)) return true;
  return liveReady && productionDeployment(env) && env.PAY_PRODUCTION_CARD_CHECKOUT_ENABLED === 'true';
}

/** Stripe wallet purchases (WeChat Pay, Alipay) through the method checkout. Staging opens only on the exact bound
 * staging deployment; `payment_method_routes.<method>.enabled` remains the server-side switch. Production (R7): only
 * the bound production deployment, behind its own default-off PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED switch. */
function walletCheckoutEnvironmentOpen(env: Env, liveReady: boolean) {
  if (stagingDeployment(env)) return true;
  return liveReady && productionDeployment(env) && env.PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED === 'true';
}

/** Card and wallet admission, checked before any settings, order or provider access. The server switches
 * `payment_method_routes.<method>.enabled` are enforced separately by assertPaymentMethodRoute with the route version. */
export function methodCheckoutEnvironmentOpen(env: Env, method: PaymentMethod, liveReady = LIVE_PAYMENT_PIPELINE_READY) {
  return method === 'card' || method === 'card_cn' ? cardCheckoutEnvironmentOpen(env, liveReady) : walletCheckoutEnvironmentOpen(env, liveReady);
}

/** Server projection for the purchase UI. Route switches and the deployment gate are both required, so
 * production wallet options cannot appear unless the bound production wallet switch is open. */
export function methodCheckoutMethods(env: Env, routes: PaymentMethodRoutes | null,
  liveReady = LIVE_PAYMENT_PIPELINE_READY): PaymentMethod[] {
  const methods: PaymentMethod[] = newPurchaseChannel(routes) === 'waffo'
    ? ['card', 'card_cn', 'alipay'] : ['card', 'card_cn', 'wechat_pay', 'alipay'];
  if (newPurchaseChannel(routes) === 'waffo') return methods.filter(method => {
    if (routes?.[method]?.enabled !== true) return false;
    try { assertWaffoCheckoutEnvironment(env, method); return true; } catch { return false; }
  });
  return methods.filter(method => routes?.[method]?.enabled === true
    && methodCheckoutEnvironmentOpen(env, method, liveReady));
}

export function assertMethodCheckoutEnvironment(env: Env, method: PaymentMethod, liveReady = LIVE_PAYMENT_PIPELINE_READY,
  testClockCustomerRequested = false) {
  const testClockStaging = testClockCustomerRequested && ['card', 'card_cn'].includes(method) && stripeTestClockStagingOpen(env);
  if (!testClockStaging && !methodCheckoutEnvironmentOpen(env, method, liveReady)) throw new Error('PAY_WAFFO_STEP2_NOT_READY');
}

/** Member-page projection: card routes behave as before; on staging, either wallet route also exposes the entry.
 * The checkout mutation re-checks the environment and selected route before creating an order. */
export function methodCheckoutReady(env: Env, routes: PaymentMethodRoutes | null, liveReady = LIVE_PAYMENT_PIPELINE_READY,
  testMode?: string) {
  if (newPurchaseChannel(routes) === 'waffo') return methodCheckoutMethods(env, routes, liveReady).length > 0;
  const regular = methodCheckoutEnvironmentOpen(env, 'card', liveReady);
  const stagingWallet = stagingDeployment(env) && (routes?.wechat_pay.enabled === true || routes?.alipay.enabled === true);
  const testClockStaging = testMode === 'test' && stripeTestClockStagingOpen(env);
  return stagingWallet || (regular && (routes?.card.enabled === true || routes?.card_cn?.enabled === true))
    || (testClockStaging && routes?.card.enabled === true);
}
