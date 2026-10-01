/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BillingUnitConfigError, parseMultiplier, parseOptionalMultiplier, providerRouteKey, type ResolvedMultiplier,
} from './billingUnit';

/**
 * BILL-UNIT third-party prices: a bounded, versioned private configuration in system_settings
 * (key billing_provider_prices; no anon/user policy matches it). Each entry turns a supplier's own
 * usage unit into USD with its official evidence, and may carry a NULL-able price multiplier.
 * No secrets live here. Absent configuration means no third-party route can be charged.
 */
export const PROVIDER_PRICES_KEY = 'billing_provider_prices';
export const MAX_PROVIDER_PRICE_ENTRIES = 64;
export const MAX_FX_VALIDITY_MS = 31 * 24 * 60 * 60 * 1000;

const SCALE = 1_000_000_000_000n;
const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/;
const decimalText = z.string().regex(DECIMAL);
const positiveDecimal = decimalText.refine((value) => /[1-9]/.test(value), 'must be positive');
const isoTime = z.string().datetime({ offset: true });
// Evidence links: https only, no embedded credentials, no query string or fragment.
const httpsUrl = z.string().url().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'https URL without credentials, query or fragment');
const multiplierText = z.string().nullable().refine((value) => {
  try { parseOptionalMultiplier(value); return true; } catch { return false; }
}, 'invalid multiplier');

const entrySchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  // Exact endpoint / SKU / API version; null marks the provider-wide entry.
  route: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/).nullable(),
  appliesToUnlistedRoutes: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  usageUnit: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
  unitsPerPrice: z.string().regex(/^[1-9][0-9]{0,8}$/),
  price: decimalText,
  usdPerCurrency: positiveDecimal.nullable(),
  // Non-USD prices need their own exchange-rate evidence and an expiry; USD entries leave these null.
  fxSourceUrl: httpsUrl.nullable(),
  fxEffectiveAt: isoTime.nullable(),
  fxValidUntil: isoTime.nullable(),
  pricingBasis: z.string().min(1).max(80),
  sourceUrl: httpsUrl,
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  verifiedAt: isoTime,
  validUntil: isoTime.nullable(),
  chargeCondition: z.string().min(1).max(200),
  includedInReceipt: z.boolean(),
  priceMultiplier: multiplierText,
}).strict().superRefine((entry, ctx) => {
  const fx = [entry.usdPerCurrency, entry.fxSourceUrl, entry.fxEffectiveAt, entry.fxValidUntil];
  if (entry.currency === 'USD' ? fx.some((v) => v !== null) : fx.some((v) => v === null)) {
    ctx.addIssue({ code: 'custom', path: ['usdPerCurrency'], message: 'USD needs no rate; other currencies need rate, source, effective date and expiry' });
  }
  if (entry.fxEffectiveAt !== null && entry.fxValidUntil !== null) {
    const span = Date.parse(entry.fxValidUntil) - Date.parse(entry.fxEffectiveAt);
    // Controller decision: an exchange rate is valid for at most 31 days, then must be re-evidenced.
    if (span <= 0 || span > MAX_FX_VALIDITY_MS) {
      ctx.addIssue({ code: 'custom', path: ['fxValidUntil'], message: 'must be after fxEffectiveAt and at most 31 days later' });
    }
  }
  if (entry.route !== null && entry.appliesToUnlistedRoutes) {
    ctx.addIssue({ code: 'custom', path: ['appliesToUnlistedRoutes'], message: 'only provider-wide entries may cover unlisted routes' });
  }
  if (entry.route === null && !entry.appliesToUnlistedRoutes) {
    ctx.addIssue({ code: 'custom', path: ['appliesToUnlistedRoutes'], message: 'a provider-wide entry that covers nothing is not allowed' });
  }
  if (entry.validUntil !== null && Date.parse(entry.validUntil) <= Date.parse(entry.verifiedAt)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'must be after verifiedAt' });
  }
});

export const providerPricesSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema).max(MAX_PROVIDER_PRICE_ENTRIES),
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.entries.forEach((entry, index) => {
    const identity = `${entry.provider}\u0000${entry.route ?? ''}`;
    if (seen.has(identity)) ctx.addIssue({ code: 'custom', path: ['entries', index], message: 'duplicate provider/route' });
    seen.add(identity);
  });
});
export type ProviderPrices = z.infer<typeof providerPricesSchema>;
export type ProviderPriceEntry = ProviderPrices['entries'][number];

export function parseProviderPrices(raw: unknown): ProviderPrices {
  let value = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_INVALID');
  }
  const result = providerPricesSchema.safeParse(value);
  if (!result.success) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_INVALID');
  return result.data;
}

/** The stored row as text plus its hash (the optimistic-concurrency token), whether or not it is valid. */
async function readProviderPricesRow(db: SupabaseClient): Promise<{ raw: string | null; hash: string | null }> {
  let result;
  try {
    result = await db.from('system_settings').select('value').eq('key', PROVIDER_PRICES_KEY).maybeSingle();
  } catch {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  }
  if (result.error) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  if (!result.data) return { raw: null, hash: null };
  const value: unknown = result.data.value;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

/** For charging: a failed read or an invalid stored value is an error; only a missing row prices nothing. */
export async function readProviderPrices(db: SupabaseClient) {
  const row = await readProviderPricesRow(db);
  if (row.raw === null) return { config: { version: 1 as const, entries: [] }, source: 'absent' as const, hash: null };
  try {
    return { config: parseProviderPrices(row.raw), source: 'configured' as const, hash: row.hash };
  } catch {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_STORED_INVALID');
  }
}

/** For the admin page: an invalid stored value is shown as such (with its hash) so it can be replaced. */
export async function providerPricesView(db: SupabaseClient) {
  try {
    return await readProviderPrices(db);
  } catch (cause) {
    if (!(cause instanceof BillingUnitConfigError) || cause.code !== 'BILLING_UNIT_PROVIDER_PRICES_STORED_INVALID') throw cause;
    return { config: null, source: 'invalid' as const, hash: (await readProviderPricesRow(db)).hash };
  }
}

/**
 * Saves only if the stored row still has the hash the admin edited (null = no row yet). The read and
 * the write are separate statements, so a concurrent save landing between them can still win.
 */
export async function saveProviderPrices(db: SupabaseClient, input: unknown, expectedHash: string | null) {
  const config = parseProviderPrices(input);
  const current = await readProviderPricesRow(db);
  if (current.hash !== expectedHash) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_CONFLICT');
  const { error } = await db.from('system_settings')
    .upsert({ key: PROVIDER_PRICES_KEY, value: JSON.stringify(config) }, { onConflict: 'key' });
  if (error) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  const saved = await readProviderPrices(db);
  // Read-back mismatch is a storage problem, not a bad request.
  if (JSON.stringify(saved.config) !== JSON.stringify(config)) {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  }
  return saved;
}

export function providerEntryHash(entry: ProviderPriceEntry): string {
  const ordered = Object.keys(entry).sort().map((key) => [key, entry[key as keyof ProviderPriceEntry]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export type ResolvedProviderPrice = {
  entry: ProviderPriceEntry;
  entryHash: string;
  matchedBy: 'route' | 'provider';
  multiplier: string;
  multiplierSource: 'provider' | 'global';
};

/**
 * Picks the single most specific entry: the exact route first; otherwise only a provider-wide
 * entry that explicitly covers unlisted routes. An explicit route entry with a NULL multiplier
 * inherits the site default — never another entry's override. Unknown or expired prices reject.
 */
export function resolveProviderPrice(
  config: ProviderPrices,
  call: { provider: string; route: string },
  defaultMultiplier: string,
  at: Date,
): ResolvedProviderPrice {
  const exact = config.entries.filter((entry) => entry.provider === call.provider && entry.route === call.route);
  const wide = config.entries.filter((entry) => entry.provider === call.provider && entry.route === null
    && entry.appliesToUnlistedRoutes);
  const candidates = exact.length > 0 ? exact : wide;
  if (candidates.length !== 1) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICE_UNKNOWN');
  const entry = candidates[0]!;
  const now = at.getTime();
  const outside = (from: string | null, until: string | null) =>
    (from !== null && Date.parse(from) > now) || (until !== null && Date.parse(until) <= now);
  // An invalid clock is not "no expiry".
  if (!Number.isFinite(now) || outside(entry.verifiedAt, entry.validUntil) || outside(entry.fxEffectiveAt, entry.fxValidUntil)) {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICE_EXPIRED');
  }
  const override = parseOptionalMultiplier(entry.priceMultiplier);
  return {
    entry,
    entryHash: providerEntryHash(entry),
    matchedBy: exact.length > 0 ? 'route' : 'provider',
    multiplier: override ?? parseMultiplier(defaultMultiplier),
    multiplierSource: override === null ? 'global' : 'provider',
  };
}

/** Multipliers for the routes an operation is approved to call, ready for buildMultiplierSnapshot(). */
export function resolveProviderMultipliers(
  config: ProviderPrices,
  routes: ReadonlyArray<{ provider: string; route: string }>,
  defaultMultiplier: string,
  at: Date,
): Record<string, ResolvedMultiplier> {
  return Object.fromEntries(routes.map((call) => {
    const resolved = resolveProviderPrice(config, call, defaultMultiplier, at);
    return [providerRouteKey(call.provider, call.route), { multiplier: resolved.multiplier, source: resolved.multiplierSource }];
  }));
}

function scaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
}

export type ProviderCost =
  | { costUsd: string; entryHash: string }
  | { costUsd: null; reason: 'included_in_receipt'; entryHash: string };

/**
 * USD cost of official usage = usage × price × usdPerCurrency / unitsPerPrice in the BILL2 12-decimal
 * USD unit. The caller must choose the rounding: 'up' for an admission upper bound, 'down' for a
 * settled actual cost, so that actual ≤ exact ≤ bound and an exact total never gains a credit from
 * rounding (the platform absorbs at most 1e-12 USD per call). A cost already inside another
 * receipt is not charged twice.
 */
export function providerUsageCostUsd(price: ResolvedProviderPrice, usage: string, rounding: 'up' | 'down'): ProviderCost {
  if (!DECIMAL.test(usage)) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_USAGE_INVALID');
  if (price.entry.includedInReceipt) return { costUsd: null, reason: 'included_in_receipt', entryHash: price.entryHash };
  const rate = price.entry.usdPerCurrency === null ? SCALE : scaled(price.entry.usdPerCurrency);
  const numerator = scaled(usage) * scaled(price.entry.price) * rate;
  const denominator = SCALE * SCALE * BigInt(price.entry.unitsPerPrice);
  const units = (numerator + (rounding === 'up' ? denominator - 1n : 0n)) / denominator;
  const whole = units / SCALE;
  if (whole >= 1_000_000_000_000n) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_USAGE_INVALID');
  const fraction = (units % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return { costUsd: fraction ? `${whole}.${fraction}` : whole.toString(), entryHash: price.entryHash };
}
