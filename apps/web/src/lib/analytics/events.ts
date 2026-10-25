/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { ANALYTICS_CONFIG } from './config';
import { readGaCheckoutIds, sendGaEvent, type GaCheckoutIds } from './ga';

/**
 * The browser key events (ANALYTICS plan §3.1). Parameters are limited to the ones listed in the plan: never
 * an email, a name, a user or order ID. Each call is a no-op unless GA is configured, Termly reports statistics
 * consent right now and the current page is reportable. Purchase success is reported by the server instead.
 */
const SIGNUP_KEY = 'graylum.analytics.signup';
const SIGNUP_WINDOW_MS = 30 * 60 * 1000;

export type SignUpUser = {
  created_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { provider?: unknown } | null;
};

/** Sign-up completed in the last 30 minutes: email verified, or the first Google sign-in. */
export function isFreshSignUp(user: SignUpUser | null | undefined, verified: boolean, now = Date.now()): boolean {
  if (!user || !verified || !user.created_at) return false;
  const google = user.app_metadata?.provider === 'google';
  const completed = Date.parse((google ? user.created_at : user.email_confirmed_at) ?? '');
  return Number.isFinite(completed) && now - completed <= SIGNUP_WINDOW_MS && completed - now <= 60_000;
}

/** `sign_up` once, within 30 minutes of completing sign-up: email verified, or the first Google sign-in. */
export function reportSignUpIfNew(user: SignUpUser | null | undefined, verified: boolean, now = Date.now()): boolean {
  if (!user || !isFreshSignUp(user, verified, now)) return false;
  const createdAt = user.created_at!;
  const method = user.app_metadata?.provider === 'google' ? 'google' : 'email';
  // Only the account's creation time is kept, to skip a repeat on the next page; written after consent only.
  try {
    if (window.localStorage.getItem(SIGNUP_KEY) === createdAt) return false;
  } catch {
    return false;
  }
  if (!sendGaEvent(ANALYTICS_CONFIG.gaMeasurementId, 'sign_up', { method })) return false;
  try {
    window.localStorage.setItem(SIGNUP_KEY, createdAt);
  } catch {
    // Storage unavailable: a later page may send it again; statistics only.
  }
  return true;
}

/** The user confirmed the last positioning step, completing a new positioning. */
export function reportPositioningComplete(): boolean {
  return sendGaEvent(ANALYTICS_CONFIG.gaMeasurementId, 'positioning_complete');
}

/** A paywall was shown to the user (opened once per display). `scene` names which paywall; no user or order ID. */
export function reportPaywallView(scene: 'report' | 'compare' | 'jury'): boolean {
  return sendGaEvent(ANALYTICS_CONFIG.gaMeasurementId, 'paywall_view', { scene });
}

/** A Stripe checkout session was created and the user is about to be sent to it (plan §3.1: currency, value and
 * the catalog item ID only; the value is the order's pre-tax amount from the server). */
export function reportBeginCheckout(itemId: string, value: number | null): boolean {
  return sendGaEvent(ANALYTICS_CONFIG.gaMeasurementId, 'begin_checkout', {
    currency: 'USD', ...(value === null ? {} : { value }), items: [{ item_id: itemId }],
  });
}

/** GA ids to send with a checkout request (consent only); the server reports the purchase after delivery. */
export function checkoutAnalyticsIds(): Promise<GaCheckoutIds | null> {
  return readGaCheckoutIds(ANALYTICS_CONFIG.gaMeasurementId).catch(() => null);
}

