/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * ALERT-FEISHU (Owner 2026-11-07): what notifyOwner(kind, facts) is told. Facts are fixed codes, internal ids, counts and
 * amounts only, never a user's email, phone, prompt or content, and never a provider payload. Each kind names its dedupe
 * key and how long the key holds:
 *  - an event kind (a refund, a dispute step, a failed webhook delivery) is keyed by the event, held longer than the
 *    provider keeps redelivering it, so it is sent once;
 *  - a condition kind (a backlog, a spike, a provider out of credit) is keyed by the condition and its TTL is the
 *    cooldown: at most one message per window while it lasts.
 * Same idea as Shotviva T72 (core/alerts/alert-kinds.ts).
 */
export type PaymentProvider = 'stripe' | 'waffo';

export type OwnerAlertFacts = {
  /** A payment callback reached us but was not processed; the provider redelivers it. */
  payment_webhook_failed: { provider: PaymentProvider; eventId: string; eventType: string | null; code: string };
  /** Callbacks are reaching us but cannot be checked or stored (bad signature, store down): nothing gets through. */
  payment_webhook_unavailable: { provider: PaymentProvider; reason: 'signature' | 'storage' };
  /** A Stripe card refund we did not start (Link, Dashboard), as recorded by pay_stripe_mp_record_external_refund. */
  refund: {
    orderId: string; refundId: string; orderKind: string;
    state: 'refunded' | 'partial_review' | 'pack_review' | 'renewing' | 'unmatched' | 'during_monthly_refund';
    refundedMinor: number | null; chargedMinor: number | null; currency: string | null;
    creditsTakenBack: number | null; creditsShortfall: number | null;
  };
  /** A step of a chargeback (opened, frozen, closed, needs a person), once per dispute and step (payment_disputes). */
  dispute: { code: string; disputeId: string; dueBy: string | null };
  /** A billing check that needs a person (daily reconciliation, annual credit release, payment notices, evidence conflict). */
  billing_review: { code: string; count: number | null };
  /** A new runtime stop-loss alert row (diagnostic_results), worded by describeStopLossAlert. */
  stop_loss: { alertId: string; line: string };
  /** The site's daily spend reached the stop-loss limit: new paid calls are refused until the next UTC day. */
  stop_loss_reached: { utcDate: string };
  /** The AI provider answered 402: the platform account could not pay, so the call failed (never charged). */
  provider_402: { provider: string };
  /** A model's platform-absorbed cost for a day went over its alert line (billing_platform_absorb_alert). */
  platform_absorb: { model: string; utcDate: string; usd: string; thresholdUsd: string };
  /** Privacy deletion or Post for Me work is falling behind (the cron checks that used to reach the Owner via Sentry). */
  ops_backlog: { code: string; level: 'warning' | 'error' | 'fatal' };
  /** Many server errors in a short time (what the Sentry error mail covered). */
  error_spike: { count: number; minutes: number };
  /** A test message: an admin runs the stop-loss diagnostic by hand (production smoke, REL-1 K10). */
  test: { note: string };
};

export type OwnerAlertKind = keyof OwnerAlertFacts;

const HOUR = 3600;
const DAY = 24 * HOUR;
/** Stripe redelivers for up to three days; a little more, so a late redelivery is still one message. */
const EVENT_TTL = 4 * DAY;

/** Error-spike rule (ALERT-FEISHU, controller 2026-11-08): at least ERROR_SPIKE.count server errors in ERROR_SPIKE.minutes, then
 * quiet for an hour. Set low for launch traffic; there is no measured baseline yet, so revisit after the first week. */
export const ERROR_SPIKE = { count: 10, minutes: 10, cooldownSeconds: HOUR } as const;

const hour = (now: Date) => now.toISOString().slice(0, 13);
const day = (now: Date) => now.toISOString().slice(0, 10);

type Rule<K extends OwnerAlertKind> = { key: (facts: OwnerAlertFacts[K], now: Date) => string; ttlSeconds: number };

export const RULES: { [K in OwnerAlertKind]: Rule<K> } = {
  payment_webhook_failed: { key: f => `${f.provider}:${f.eventId}`, ttlSeconds: EVENT_TTL },
  payment_webhook_unavailable: { key: f => `${f.provider}:${f.reason}`, ttlSeconds: HOUR },
  // The state is part of the key: a refund that first needs review and is later recorded is two facts.
  refund: { key: f => `${f.state}:${f.orderId}:${f.refundId}`, ttlSeconds: EVENT_TTL },
  dispute: { key: f => `${f.code}:${f.disputeId}`, ttlSeconds: 30 * DAY },
  // Daily checks re-raise while the finding stands: once a day per code.
  billing_review: { key: (f, now) => `${f.code}:${day(now)}`, ttlSeconds: DAY },
  stop_loss: { key: f => f.alertId, ttlSeconds: 8 * DAY },
  stop_loss_reached: { key: f => f.utcDate, ttlSeconds: 2 * DAY },
  provider_402: { key: f => f.provider, ttlSeconds: HOUR / 2 },
  // Acknowledging in the admin ends the alert; until then once per model and day.
  platform_absorb: { key: f => `${f.model}:${f.utcDate}`, ttlSeconds: 8 * DAY },
  // A new, worse level is a new message; the same level at most every six hours.
  ops_backlog: { key: f => `${f.code}:${f.level}`, ttlSeconds: 6 * HOUR },
  error_spike: { key: () => 'site', ttlSeconds: ERROR_SPIKE.cooldownSeconds },
  test: { key: (_f, now) => hour(now), ttlSeconds: 60 },
};

/** `<kind>:<key>`, safe for a Redis key and bounded in length. */
export function dedupeKey<K extends OwnerAlertKind>(kind: K, facts: OwnerAlertFacts[K], now: Date): string {
  const raw = `${kind}:${(RULES[kind] as Rule<K>).key(facts, now)}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 200);
}

export function ttlSeconds(kind: OwnerAlertKind): number {
  return RULES[kind].ttlSeconds;
}
