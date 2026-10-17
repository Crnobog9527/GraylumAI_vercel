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

/** `sign_up` once, within 30 minutes of completing sign-up: email verified, or the first Google sign-in. */
export function reportSignUpIfNew(user: SignUpUser | null | undefined, verified: boolean, now = Date.now()): boolean {
  const createdAt = user?.created_at;
  if (!user || !verified || !createdAt) return false;
  const method = user.app_metadata?.provider === 'google' ? 'google' : 'email';
  const completed = Date.parse((method === 'google' ? createdAt : user.email_confirmed_at) ?? '');
  if (!Number.isFinite(completed) || now - completed > SIGNUP_WINDOW_MS || completed - now > 60_000) return false;
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

