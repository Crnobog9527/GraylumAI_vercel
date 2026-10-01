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

const SCALE = 1_000_000_000_000n;
const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/;
const decimalText = z.string().regex(DECIMAL);
const positiveDecimal = decimalText.refine((value) => /[1-9]/.test(value), 'must be positive');
const isoTime = z.string().datetime({ offset: true });
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
  pricingBasis: z.string().min(1).max(80),
  sourceUrl: z.string().url().max(500).refine((url) => url.startsWith('https://'), 'https only'),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  verifiedAt: isoTime,
  validUntil: isoTime.nullable(),
  chargeCondition: z.string().min(1).max(200),
  includedInReceipt: z.boolean(),
  priceMultiplier: multiplierText,
}).strict().superRefine((entry, ctx) => {
  if ((entry.currency === 'USD') !== (entry.usdPerCurrency === null)) {
    ctx.addIssue({ code: 'custom', path: ['usdPerCurrency'], message: 'USD needs no rate; other currencies need one' });
  }
  if (entry.route !== null && entry.appliesToUnlistedRoutes) {
    ctx.addIssue({ code: 'custom', path: ['appliesToUnlistedRoutes'], message: 'only provider-wide entries may cover unlisted routes' });
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

/** A failed read or invalid stored value is an error; only a confirmed-missing row is "no routes priced". */
export async function readProviderPrices(db: SupabaseClient) {
  let result;
  try {
    result = await db.from('system_settings').select('value').eq('key', PROVIDER_PRICES_KEY).maybeSingle();
  } catch {
    throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  }
  if (result.error) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE');
  if (!result.data) return { config: { version: 1 as const, entries: [] }, source: 'absent' as const };
  return { config: parseProviderPrices(result.data.value), source: 'configured' as const };
}

export async function saveProviderPrices(db: SupabaseClient, input: unknown) {
  const config = parseProviderPrices(input);
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
  if (Date.parse(entry.verifiedAt) > now || (entry.validUntil !== null && Date.parse(entry.validUntil) <= now)) {
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

/**
 * USD cost of official usage = usage × price × usdPerCurrency / unitsPerPrice, rounded up to the
 * BILL2 12-decimal USD unit (never down). Returns null when the cost is already inside another
 * receipt, so it is not charged twice.
 */
export function providerUsageCostUsd(price: ResolvedProviderPrice, usage: string): string | null {
  if (!DECIMAL.test(usage)) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_USAGE_INVALID');
  if (price.entry.includedInReceipt) return null;
  const rate = price.entry.usdPerCurrency === null ? SCALE : scaled(price.entry.usdPerCurrency);
  const numerator = scaled(usage) * scaled(price.entry.price) * rate;
  const denominator = SCALE * SCALE * BigInt(price.entry.unitsPerPrice);
  const units = (numerator + denominator - 1n) / denominator;
  const whole = units / SCALE;
  if (whole >= 1_000_000_000_000n) throw new BillingUnitConfigError('BILLING_UNIT_PROVIDER_USAGE_INVALID');
  const fraction = (units % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
